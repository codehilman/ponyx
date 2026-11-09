import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'read_async');

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in"/>
      <arg type="x" direction="in"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>`);

const AppProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

function metaValue(metadata, key) {
    return metadata?.[key]?.recursiveUnpack() ?? null;
}

function makeProxy(Wrapper, busName, cancellable) {
    return new Promise((resolve, reject) => {
        Wrapper(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error)
                reject(error);
            else
                resolve(proxy);
        }, cancellable);
    });
}

/**
 * Tracks MPRIS players on the session bus and exposes the one worth showing:
 * whichever is playing, otherwise the one that changed most recently.
 * Emits 'changed' whenever that player or its track changes.
 */
export class MediaWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();
        this._bus = Gio.DBus.session;

        this._ownerSub = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._bus.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, result) => {
                let names;
                try {
                    [names] = conn.call_finish(result).deepUnpack();
                } catch {
                    return;
                }
                names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
            });
    }

    async _addPlayer(busName) {
        if (this._players.has(busName))
            return;
        const entry = {busName, player: null, app: null, signalId: 0, touched: Date.now()};
        this._players.set(busName, entry);

        try {
            [entry.player, entry.app] = await Promise.all([
                makeProxy(PlayerProxy, busName, this._cancellable),
                makeProxy(AppProxy, busName, this._cancellable),
            ]);
        } catch {
            this._players.delete(busName);
            return;
        }

        if (this._players.get(busName) !== entry)
            return;
        entry.signalId = entry.player.connect('g-properties-changed', () => {
            entry.touched = Date.now();
            this.emit('changed');
        });
        this.emit('changed');
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;
        if (entry.signalId)
            entry.player.disconnect(entry.signalId);
        this._players.delete(busName);
        this.emit('changed');
    }

    _current() {
        let best = null;
        for (const entry of this._players.values()) {
            if (!entry.player || !entry.player.Metadata)
                continue;
            const score = (entry.player.PlaybackStatus === 'Playing' ? 1e15 : 0) + entry.touched;
            if (!best || score > best.score)
                best = {entry, score};
        }
        return best?.entry ?? null;
    }

    get state() {
        const entry = this._current();
        if (!entry)
            return null;
        const {player, app} = entry;
        const metadata = player.Metadata;
        const title = metaValue(metadata, 'xesam:title');
        if (!title)
            return null;
        const artists = metaValue(metadata, 'xesam:artist');
        return {
            title,
            artist: Array.isArray(artists) ? artists.join(', ') : artists ?? '',
            album: metaValue(metadata, 'xesam:album') ?? '',
            artUrl: metaValue(metadata, 'mpris:artUrl'),
            playing: player.PlaybackStatus === 'Playing',
            canNext: player.CanGoNext ?? true,
            canPrevious: player.CanGoPrevious ?? true,
            canSeek: player.CanSeek ?? false,
            // MPRIS times are in microseconds.
            length: Number(metaValue(metadata, 'mpris:length') ?? 0),
            identity: app?.Identity ?? '',
            desktopEntry: app?.DesktopEntry ?? '',
        };
    }

    // Players don't emit change signals for Position, so it has to be read on demand.
    async position() {
        const entry = this._current();
        if (!entry)
            return null;
        try {
            const reply = await this._bus.call(
                entry.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1000, this._cancellable);
            return Number(reply.deepUnpack()[0].unpack());
        } catch {
            return null;
        }
    }

    setPosition(microseconds) {
        const entry = this._current();
        const trackId = metaValue(entry?.player.Metadata, 'mpris:trackid');
        if (!trackId || !GLib.Variant.is_object_path(trackId))
            return;
        entry.player.SetPositionRemote(trackId, Math.max(0, Math.round(microseconds)));
    }

    playPause() {
        this._current()?.player.PlayPauseRemote();
    }

    next() {
        this._current()?.player.NextRemote();
    }

    previous() {
        this._current()?.player.PreviousRemote();
    }

    destroy() {
        this._cancellable.cancel();
        this._bus.signal_unsubscribe(this._ownerSub);
        for (const name of [...this._players.keys()])
            this._removePlayer(name);
        this.disconnectAll();
    }
}

/**
 * Picks a representative color from a local image URI as [r, g, b], or null.
 * Colorful pixels count more than grey ones, so a vivid cover on a dark field still gets its hue.
 */
export async function artColor(uri, cancellable = null) {
    if (!uri)
        return null;
    let pixbuf;
    try {
        const stream = await Gio.File.new_for_uri(uri).read_async(GLib.PRIORITY_LOW, cancellable);
        pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 32, 32, false, cancellable, (_s, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        stream.close(null);
    } catch {
        return null;
    }

    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const alpha = pixbuf.get_has_alpha();
    let r = 0, g = 0, b = 0, total = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            if (alpha && pixels[i + 3] < 128)
                continue;
            const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            // Saturation dominates the weight; near-black pixels barely count.
            const weight = 0.05 + ((max - min) / 255) ** 2 * (max / 255);
            r += pr * weight;
            g += pg * weight;
            b += pb * weight;
            total += weight;
        }
    }
    if (!total)
        return null;
    return [r, g, b].map(c => Math.round(c / total));
}

/**
 * Turns an MPRIS art URL into a local file URI that St can paint.
 * Remote covers (Spotify, browsers) are downloaded once into the cache dir.
 */
export class ArtCache {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ponyx', 'art']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        this._session = new Soup.Session({timeout: 15, user_agent: 'ponyx-gnome-extension'});
        this._cancellable = new Gio.Cancellable();
    }

    async resolve(url) {
        if (!url)
            return null;
        if (url.startsWith('file://'))
            return url;
        if (!/^https?:\/\//.test(url))
            return null;

        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]));
        if (file.query_exists(null))
            return file.get_uri();

        const message = Soup.Message.new('GET', url);
        if (!message)
            return null;
        try {
            const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable);
            if (message.get_status() !== 200)
                return null;
            await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, this._cancellable);
        } catch {
            return null;
        }
        return file.get_uri();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}
