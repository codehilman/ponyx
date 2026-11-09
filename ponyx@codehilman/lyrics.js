import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const API = 'https://lrclib.net/api';
// LRCLIB matches /api/get within about 2 seconds; search results get the same tolerance.
const DURATION_SLACK_S = 3;
const STAMP = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

// "[01:02.50][02:10.00] text" → [{time: 62.5, text}, {time: 130, text}], sorted by time in seconds.
export function parseLrc(source) {
    const lines = [];
    for (const raw of source.split(/\r?\n/)) {
        const stamps = [...raw.matchAll(STAMP)];
        if (!stamps.length)
            continue;
        const text = raw.slice(stamps.at(-1).index + stamps.at(-1)[0].length).trim();
        for (const [, minutes, seconds] of stamps)
            lines.push({time: Number(minutes) * 60 + Number(seconds), text});
    }
    return lines.sort((a, b) => a.time - b.time);
}

// Index of the line sung at `seconds`, or -1 before the first line.
export function lineAt(lines, seconds) {
    let low = 0, high = lines.length - 1, found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].time <= seconds) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

function toLyrics(record) {
    if (!record)
        return null;
    const synced = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
    const plain = record.plainLyrics?.trim() || null;
    if (!synced.length && !plain && !record.instrumental)
        return null;
    return {synced, plain, instrumental: !!record.instrumental};
}

/**
 * Looks up lyrics on LRCLIB (lrclib.net), preferring time-synced ones.
 * Found lyrics are kept in the cache dir, so each track is requested once.
 */
export class LyricsClient {
    // LRCLIB asks clients to identify themselves with name, version and homepage.
    constructor(metadata = {}) {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ponyx', 'lyrics']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        const version = metadata['version-name'] ?? metadata.version ?? 'dev';
        const homepage = metadata.url ? ` (${metadata.url})` : '';
        this._session = new Soup.Session({timeout: 15, user_agent: `Ponyx/${version}${homepage}`});
        this._missing = new Set();
    }

    // Resolves to {synced, plain, instrumental} or null when the track has no lyrics.
    async lookup({title, artist, album, length}, cancellable) {
        const seconds = Math.round(length / 1e6);
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
            JSON.stringify([title, artist, album, seconds]), -1);
        if (this._missing.has(key))
            return null;

        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, `${key}.json`]));
        try {
            const [contents] = await file.load_contents_async(cancellable);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }

        const lyrics = await this._fetch(title, artist, album, seconds, cancellable);
        if (!lyrics) {
            this._missing.add(key);
            return null;
        }
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(lyrics)));
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null).catch(() => {});
        return lyrics;
    }

    async _fetch(title, artist, album, seconds, cancellable) {
        if (album && seconds > 0) {
            const exact = await this._request('get',
                {track_name: title, artist_name: artist, album_name: album, duration: String(seconds)}, cancellable);
            const lyrics = toLyrics(exact);
            if (lyrics)
                return lyrics;
        }

        // Players often report several artists as one string; the first one is what LRCLIB knows.
        const results = await this._request('search',
            {track_name: title, artist_name: artist.split(/,|&| feat\.? /i)[0].trim()}, cancellable);
        if (!Array.isArray(results))
            return null;
        const fits = results.filter(r => !seconds || !r.duration || Math.abs(r.duration - seconds) <= DURATION_SLACK_S);
        return toLyrics(fits.find(r => r.syncedLyrics) ?? fits.find(r => r.plainLyrics || r.instrumental));
    }

    async _request(endpoint, params, cancellable) {
        const query = Object.entries(params)
            .map(([name, value]) => `${name}=${GLib.Uri.escape_string(value, null, false)}`)
            .join('&');
        const message = Soup.Message.new('GET', `${API}/${endpoint}?${query}`);
        if (!message)
            return null;
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable);
        if (message.get_status() !== 200)
            return null;
        try {
            return JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch {
            return null;
        }
    }

    destroy() {
        this._session.abort();
    }
}
