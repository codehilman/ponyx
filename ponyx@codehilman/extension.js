import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Cairo from 'gi://cairo';
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {UsageClient, UsageError, formatCountdown, formatAgo, serializeUsage, restoreUsage} from './usage.js';
import {MediaWatcher, ArtCache, artColor} from './media.js';
import {LyricsClient, lineAt} from './lyrics.js';

const COLLAPSED_WIDTH = 220;
const COLLAPSED_CLOCK_WIDTH = 300;
// Each compact side grows by this much while the track ticker shows (matches .ticking in the stylesheet).
const TICKER_SIDE_EXTRA = 96;
const TICKER_GAP = 36;
const TICKER_PX_PER_SECOND = 32;
const TICKER_RESUME_DELAY_MS = 200;
const POPUP_WIDTH = 340;
const EXPANDED_WIDTH = 660;
const EXPANDED_HEIGHT = 236;
const OPEN_DELAY_MS = 140;
const CLOSE_DELAY_MS = 380;
const RESIZE_MS = 420;
const POPUP_MS = 1600;
const SEEK_POLL_MS = 1000;
// Lyrics follow a clock extrapolated from the last polled position, so they move between polls.
const LYRICS_TICK_MS = 200;
const TICK_SECONDS = 30;
const STALE_AFTER_MS = 3 * 60 * 1000;
const VOLUME_STEP = 0.05;

const CLAUDE_ORANGE = '#d97757';
const HIGH_USAGE = '#ff453a';
const HIGH_USAGE_FROM = 75;
const ALERT_LEVELS = [75, 90];
const PULSE_FROM = 90;

// UPower device states that mean the charger is connected.
const UPOWER_PLUGGED = new Set([1, 4, 5]);

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
  </interface>
</node>`);

const levelColor = percent => percent >= HIGH_USAGE_FROM ? HIGH_USAGE : CLAUDE_ORANGE;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

function formatDuration(microseconds) {
    const total = Math.max(0, Math.round(microseconds / 1e6));
    const seconds = String(total % 60).padStart(2, '0');
    const minutes = Math.floor(total / 60);
    if (minutes < 60)
        return `${minutes}:${seconds}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

function volumeIcon(level) {
    if (level <= 0)
        return 'audio-volume-muted-symbolic';
    if (level < 1 / 3)
        return 'audio-volume-low-symbolic';
    if (level < 2 / 3)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

const isCancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

const UsageRing = GObject.registerClass(
class UsageRing extends St.DrawingArea {
    _init(styleClass, lineWidth) {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._lineWidth = lineWidth;
        this._percent = null;
    }

    set percent(value) {
        this._percent = value;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const line = this._lineWidth * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = Math.min(width, height) / 2 - line / 2;
        const start = -Math.PI / 2;

        cr.setLineWidth(line);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(1, 1, 1, 0.15);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._percent) {
            const [r, g, b] = hexToRgb(levelColor(this._percent));
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(width / 2, height / 2, radius, start, start + 2 * Math.PI * this._percent / 100);
            cr.stroke();
        }
        cr.$dispose();
    }
});

const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init() {
        super._init({style_class: 'ponyx-bar', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'ponyx-bar-fill'});
        this.add_child(this._fill);
        this._percent = 0;
        this._color = null;
    }

    // A fixed color; when unset the fill follows the usage level.
    set color(value) {
        this._color = value;
        this._restyle();
    }

    set percent(value) {
        this._percent = value ?? 0;
        this._restyle();
        this.queue_relayout();
    }

    _restyle() {
        this._fill.style = `background-color: ${this._color ?? levelColor(this._percent)};`;
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = Math.round((content.x2 - content.x1) * this._percent / 100);
        this._fill.allocate(Clutter.ActorBox.new(content.x1, content.y1, content.x1 + width, content.y2));
    }
});

function iconButton(iconName, styleClass, accessibleName, onClick) {
    const icon = new St.Icon({icon_name: iconName});
    const button = new St.Button({
        style_class: styleClass,
        child: icon,
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', onClick);
    return {button, icon};
}

function popupView(styleClass) {
    const box = new St.BoxLayout({style_class: styleClass, opacity: 0, visible: false, y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({style_class: 'ponyx-popup-icon', y_align: Clutter.ActorAlign.CENTER});
    const label = new St.Label({style_class: 'ponyx-popup-label', y_align: Clutter.ActorAlign.CENTER});
    const bar = new UsageBar();
    const value = new St.Label({style_class: 'ponyx-popup-value', y_align: Clutter.ActorAlign.CENTER});
    for (const child of [icon, label, bar, value])
        box.add_child(child);
    return {box, icon, label, bar, value};
}

function fadeIn(actor) {
    actor.show();
    actor.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

function fadeOut(actor) {
    actor.ease({
        opacity: 0,
        duration: 140,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => actor.hide(),
    });
}

class Island {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._expanded = false;
        this._usage = null;
        this._usageError = null;
        this._fetching = false;
        this._lastAttempt = 0;
        this._retryAt = 0;
        this._artUrl = undefined;
        this._calendarDay = null;
        this._hoverTimer = 0;
        this._refreshTimer = 0;
        this._tickTimer = 0;
        this._popupTimer = 0;
        this._popupShown = false;
        this._seekTimer = 0;
        this._lyricsTimer = 0;
        this._lyrics = null;
        this._lyricsKey = null;
        this._lyricsLine = null;
        this._positionSample = null;
        this._seekDragging = false;
        this._seekUpdating = false;
        this._scrollDelta = 0;
        this._pulsing = false;
        this._rateLimitNotice = false;
        this._collapsedWidth = 0;
        // Start from the last reading so a restart during a rate limit isn't blank,
        // and don't fetch again before a limit we already hit has passed.
        ({usage: this._usage, retryAt: this._retryAt} = restoreUsage(this._settings.get_string('usage-cache')));

        this._cancellable = new Gio.Cancellable();
        this._client = new UsageClient();
        this._artCache = new ArtCache();
        this._lyricsClient = new LyricsClient(extension.metadata);
        this._media = new MediaWatcher();
        // WallClock ticks on minute boundaries and follows timezone changes, like the top bar clock.
        this._wallClock = new GnomeDesktop.WallClock();
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._mixer = getMixerControl();
        this._sinkId = this._mixer.get_default_sink()?.id;
        this._eventSource = Main.sessionMode.showCalendarEvents ? new Calendar.DBusEventSource() : null;

        this._buildActors();
        Main.layoutManager.addTopChrome(this.actor, {trackFullscreen: true});

        const centerBox = Main.panel._centerBox;
        this._clockIndex = Math.max(0, centerBox.get_children().indexOf(Main.panel.statusArea.dateMenu?.container));
        this._setClockMoved(this._settings.get_boolean('move-clock'));

        this._media.connectObject('changed', () => this._syncMedia(), this);
        this._wallClock.connectObject('notify::clock', () => this._syncClock(), this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this._syncClock(), this);
        this._mixer.connectObject('default-sink-changed', () => this._onSinkChanged(), this);
        this._eventSource?.connectObject('changed', () => this._syncEvents(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        Main.panel.connectObject('notify::height', () => this._relayout(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => this._relayout(), this);
        this._settings.connectObject(
            'changed::refresh-minutes', () => this._scheduleRefresh(),
            'changed::move-clock', () => this._setClockMoved(this._settings.get_boolean('move-clock')),
            'changed::show-clock', () => this._syncClock(),
            'changed::usage-alerts', () => this._syncUsage(),
            'changed::show-lyrics', () => this._syncMedia(),
            this);

        this._hookOsd();
        this._watchPower();

        this._syncClock();
        this._relayout();
        this._selectTab('music');
        this._syncUsage();
        this._syncMedia();
        this._refreshUsage();
        this._scheduleRefresh();
        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._syncCalendar();
            this._syncUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildActors() {
        this.actor = new St.Widget({
            name: 'ponyxIsland',
            style_class: 'ponyx-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.actor.connect('notify::hover', () => this._onHoverChanged());
        this.actor.connect('notify::width', () => this._centerChildren());
        this.actor.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this.actor.connect('button-release-event', (_actor, event) => {
            if (this._expanded || event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._open();
            return Clutter.EVENT_STOP;
        });

        this._compact = this._buildCompact();
        this._notchPopup = popupView('ponyx-popup');
        this._expandedBox = this._buildExpanded();
        this.actor.add_child(this._compact);
        this.actor.add_child(this._notchPopup.box);
        this.actor.add_child(this._expandedBox);
    }

    _buildCompact() {
        // With the clock, the notch is sized to its content (see _sizes). Without it, the start side
        // takes the spare width and the end side hugs the ring.
        const box = new St.BoxLayout({style_class: 'ponyx-compact'});

        const start = new St.BoxLayout({style_class: 'ponyx-compact-side ponyx-compact-start'});
        this._compactStart = start;
        this._compactArt = new St.Bin({style_class: 'ponyx-compact-art', y_align: Clutter.ActorAlign.CENTER});
        // Fills the start side when nothing plays; album art takes its place during playback.
        this._compactGlyph = new St.Label({text: '✻', style_class: 'ponyx-glyph', y_align: Clutter.ActorAlign.CENTER});
        start.add_child(this._compactArt);
        start.add_child(this._compactGlyph);
        start.add_child(this._buildTicker());

        this._compactClock = new St.BoxLayout({
            style_class: 'ponyx-compact-clock',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactDate = new St.Label({style_class: 'ponyx-compact-date', y_align: Clutter.ActorAlign.CENTER});
        this._compactTime = new St.Label({style_class: 'ponyx-compact-time', y_align: Clutter.ActorAlign.CENTER});
        this._compactClock.add_child(this._compactDate);
        this._compactClock.add_child(new St.Label({text: '·', style_class: 'ponyx-compact-date', y_align: Clutter.ActorAlign.CENTER}));
        this._compactClock.add_child(this._compactTime);

        const end = new St.BoxLayout({style_class: 'ponyx-compact-side'});
        this._compactEnd = end;
        end.add_child(new St.Widget({x_expand: true}));
        this._compactRing = new UsageRing('ponyx-ring-small', 2);
        this._compactRing.y_align = Clutter.ActorAlign.FILL;
        // The ring and the ✻ inside it pulse together, so they share one container.
        this._compactBadge = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactBadge.add_child(this._compactRing);
        this._compactBadge.add_child(new St.Label({
            text: '✻',
            style_class: 'ponyx-ring-glyph',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._compactPct = new St.Label({style_class: 'ponyx-compact-pct', y_align: Clutter.ActorAlign.CENTER});
        end.add_child(this._compactBadge);
        end.add_child(this._compactPct);

        box.add_child(start);
        box.add_child(this._compactClock);
        box.add_child(end);
        return box;
    }

    // "Title — Artist" that scrolls right-to-left when it doesn't fit, fading out at the right edge.
    _buildTicker() {
        this._tickerShown = false;
        this._tickerText = '';
        this._ticker = new St.Widget({
            style_class: 'ponyx-ticker',
            clip_to_allocation: true,
            // Size comes only from x_expand, so the ticker never asks for the width of its own text.
            min_width: 0,
            natural_width: 0,
            x_expand: true,
            y_expand: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._tickerTrack = new St.BoxLayout({style_class: 'ponyx-ticker-track'});
        this._tickerLabels = [0, 1].map(() => {
            const label = new St.Label({style_class: 'ponyx-ticker-label', y_align: Clutter.ActorAlign.CENTER});
            this._tickerTrack.add_child(label);
            return label;
        });
        this._tickerFade = new St.Widget({style_class: 'ponyx-ticker-fade'});
        this._tickerFadeStart = new St.Widget({style_class: 'ponyx-ticker-fade-start'});
        const fillHeight = () => new Clutter.BindConstraint({source: this._ticker, coordinate: Clutter.BindCoordinate.HEIGHT});
        this._tickerTrack.add_constraint(fillHeight());
        this._tickerFade.add_constraint(fillHeight());
        this._tickerFadeStart.add_constraint(fillHeight());
        this._tickerFade.add_constraint(new Clutter.AlignConstraint({source: this._ticker, align_axis: Clutter.AlignAxis.X_AXIS, factor: 1}));
        this._ticker.add_child(this._tickerTrack);
        this._ticker.add_child(this._tickerFade);
        this._ticker.add_child(this._tickerFadeStart);
        this._ticker.connect('notify::width', () => this._queueTickerRestart());
        return this._ticker;
    }

    // Re-measure once layout has settled: restarting inside allocation would queue another relayout,
    // and right after a text change the old allocation is all there is to measure.
    _queueTickerRestart() {
        if (this._tickerLater)
            return;
        this._tickerLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._tickerLater = 0;
            this._restartTicker();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setTicker(state) {
        const shown = !!state;
        if (state?.playing)
            this._ticker.remove_style_class_name('paused');
        else
            this._ticker.add_style_class_name('paused');
        const text = state ? [state.title, state.artist].filter(Boolean).join('  —  ') : '';
        if (text !== this._tickerText) {
            this._tickerText = text;
            for (const label of this._tickerLabels)
                label.text = text;
            this._queueTickerRestart();
        }
        if (shown === this._tickerShown)
            return;
        this._tickerShown = shown;
        this._ticker.visible = shown;
        if (shown)
            this._compact.add_style_class_name('ticking');
        else
            this._compact.remove_style_class_name('ticking');
        const {collapsed} = this._sizes();
        this._compact.set_size(...collapsed);
        if (!this._expanded && !this._popupShown)
            this._place(...collapsed, true);
        this._queueTickerRestart();
    }

    // Pausing keeps the scroll offset, so hovering in and out never makes the text jump.
    _syncTickerMotion() {
        const transition = this._tickerTrack.get_transition('translation-x');
        if (!transition)
            return;
        if (this._expanded || this._popupShown)
            transition.pause();
        else if (!transition.is_playing()) {
            // The long lead-in is for a fresh track; after the panel closes, pick up as the notch fades back in.
            transition.delay = TICKER_RESUME_DELAY_MS;
            transition.start();
        }
    }

    _restartTicker() {
        const track = this._tickerTrack;
        track.remove_all_transitions();
        track.translation_x = 0;
        const [label, copy] = this._tickerLabels;
        const textWidth = label.get_preferred_width(-1)[1];
        // The real allocation, not `width`, which reports the preferred width while a relayout is pending.
        const width = this._ticker.get_allocation_box().get_width();
        const overflows = this._tickerShown && width > 0 && textWidth > width;
        copy.visible = overflows;
        this._tickerFade.visible = this._tickerFadeStart.visible = overflows;
        track.style = `spacing: ${TICKER_GAP}px;`;
        if (!overflows)
            return;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const distance = textWidth + TICKER_GAP * scale;
        track.ease({
            translation_x: -distance,
            duration: Math.round(distance / (TICKER_PX_PER_SECOND * scale) * 1000),
            delay: 1200,
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: -1,
        });
        this._syncTickerMotion();
    }

    _buildExpanded() {
        const box = new St.BoxLayout({
            style_class: 'ponyx-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            opacity: 0,
            visible: false,
        });

        const header = new St.BoxLayout({style_class: 'ponyx-header'});
        this._tabs = {
            music: this._makeTab('Music', new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ponyx-tab-icon'})),
            claude: this._makeTab('Claude', new St.Label({text: '✻', style_class: 'ponyx-tab-glyph', y_align: Clutter.ActorAlign.CENTER})),
        };
        this._headerPopup = popupView('ponyx-header-popup');
        header.add_child(this._tabs.music);
        header.add_child(this._tabs.claude);
        header.add_child(new St.Widget({x_expand: true}));
        header.add_child(this._headerPopup.box);
        header.add_child(iconButton('emblem-system-symbolic', 'ponyx-icon-button', 'Ponyx settings', () => {
            this._close();
            this._extension.openPreferences();
        }).button);

        const pages = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._pages = {music: this._buildMusicPage(), claude: this._buildClaudePage()};
        pages.add_child(this._pages.music);
        pages.add_child(this._pages.claude);

        box.add_child(header);
        box.add_child(pages);
        return box;
    }

    _makeTab(label, glyph) {
        const content = new St.BoxLayout({style_class: 'ponyx-tab-box'});
        content.add_child(glyph);
        content.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        const tab = new St.Button({style_class: 'ponyx-tab', child: content, can_focus: true, accessible_name: label});
        tab.connect('clicked', () => this._selectTab(label.toLowerCase()));
        return tab;
    }

    _buildMusicPage() {
        const page = new St.BoxLayout({style_class: 'ponyx-page ponyx-music-page', x_expand: true, y_expand: true});
        page.add_child(this._buildMedia());
        page.add_child(new St.Widget({style_class: 'ponyx-divider', y_expand: true}));
        page.add_child(this._buildCalendar());
        return page;
    }

    _buildMedia() {
        const media = new St.Widget({style_class: 'ponyx-media', layout_manager: new Clutter.BinLayout(), y_expand: true});

        this._mediaContent = new St.BoxLayout({
            style_class: 'ponyx-media-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const artFrame = new St.Widget({style_class: 'ponyx-art-frame', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.START});
        this._art = new St.Bin({style_class: 'ponyx-art', x_expand: true, y_expand: true});
        this._artPlaceholder = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'ponyx-art-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._appBadge = new St.Icon({style_class: 'ponyx-app-badge', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END});
        artFrame.add_child(this._art);
        artFrame.add_child(this._artPlaceholder);
        artFrame.add_child(this._appBadge);

        const track = new St.BoxLayout({
            style_class: 'ponyx-track',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._title = new St.Label({style_class: 'ponyx-title'});
        this._artist = new St.Label({style_class: 'ponyx-artist'});
        this._album = new St.Label({style_class: 'ponyx-album'});
        track.add_child(this._title);
        track.add_child(this._artist);
        track.add_child(this._album);
        track.add_child(this._buildLyrics());

        const top = new St.BoxLayout({style_class: 'ponyx-media-top', x_expand: true});
        top.add_child(artFrame);
        top.add_child(track);

        // Times sit under the ends of the bar; equal-width slots keep the controls centered.
        const transport = new St.BoxLayout({style_class: 'ponyx-transport', x_expand: true});
        this._elapsed = new St.Label({style_class: 'ponyx-seek-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'ponyx-seek-time ponyx-seek-remaining', y_align: Clutter.ActorAlign.CENTER});
        const controls = new St.BoxLayout({style_class: 'ponyx-controls', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._previousButton = iconButton('media-skip-backward-symbolic', 'ponyx-control', 'Previous track', () => this._media.previous()).button;
        const playPause = iconButton('media-playback-start-symbolic', 'ponyx-control ponyx-control-main', 'Play or pause', () => this._media.playPause());
        this._playIcon = playPause.icon;
        this._nextButton = iconButton('media-skip-forward-symbolic', 'ponyx-control', 'Next track', () => this._media.next()).button;
        controls.add_child(this._previousButton);
        controls.add_child(playPause.button);
        controls.add_child(this._nextButton);
        transport.add_child(this._elapsed);
        transport.add_child(controls);
        transport.add_child(this._remaining);

        this._mediaContent.add_child(top);
        this._mediaContent.add_child(this._buildSeek());
        this._mediaContent.add_child(transport);

        this._mediaEmpty = new St.BoxLayout({
            style_class: 'ponyx-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaEmpty.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'ponyx-empty-icon'}));
        this._mediaEmpty.add_child(new St.Label({text: 'Nothing playing', style_class: 'ponyx-empty-label'}));

        media.add_child(this._mediaContent);
        media.add_child(this._mediaEmpty);
        return media;
    }

    _buildSeek() {
        this._seek = new Slider(0);
        this._seek.add_style_class_name('ponyx-seek');
        this._seek.accessible_name = 'Track position';
        this._seek.x_expand = true;

        this._seek.connect('drag-begin', () => {
            this._seekDragging = true;
        });
        this._seek.connect('drag-end', () => {
            this._seekDragging = false;
            this._commitSeek();
        });
        this._seek.connect('notify::value', () => {
            if (this._seekUpdating)
                return;
            // Keyboard and scroll changes arrive without a drag; drags commit on release.
            if (this._seekDragging)
                this._showSeekTimes(this._seek.value * (this._media.state?.length ?? 0));
            else
                this._commitSeek();
        });

        return this._seek;
    }

    // Synced lyrics show only the line being sung, swapped in time with the song; plain lyrics scroll as one block.
    _buildLyrics() {
        this._lyricsBox = new St.BoxLayout({
            style_class: 'ponyx-lyrics',
            orientation: Clutter.Orientation.VERTICAL,
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        this._syncedBox = new St.BoxLayout({
            style_class: 'ponyx-lyrics-synced',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._lyricNow = new St.Label({style_class: 'ponyx-lyric-now'});
        // A long line wraps rather than being cut off; it is still one lyric line.
        this._lyricNow.clutter_text.line_wrap = true;
        this._syncedBox.add_child(this._lyricNow);

        const plainText = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._lyricPlain = new St.Label({style_class: 'ponyx-lyric-plain'});
        this._lyricPlain.clutter_text.line_wrap = true;
        plainText.add_child(this._lyricPlain);
        this._plainScroll = new St.ScrollView({
            style_class: 'ponyx-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: plainText,
        });

        this._lyricsBox.add_child(this._syncedBox);
        this._lyricsBox.add_child(this._plainScroll);
        return this._lyricsBox;
    }

    _buildCalendar() {
        const calendar = new St.BoxLayout({
            style_class: 'ponyx-calendar',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const top = new St.BoxLayout({style_class: 'ponyx-cal-top'});
        this._month = new St.Label({style_class: 'ponyx-month', y_align: Clutter.ActorAlign.CENTER});
        this._days = new St.BoxLayout({style_class: 'ponyx-days', x_expand: true, x_align: Clutter.ActorAlign.END});
        top.add_child(this._month);
        top.add_child(this._days);

        this._eventRow = new St.BoxLayout({style_class: 'ponyx-event'});
        this._eventDot = new St.Widget({style_class: 'ponyx-event-dot', y_align: Clutter.ActorAlign.CENTER});
        this._eventTime = new St.Label({style_class: 'ponyx-event-time', y_align: Clutter.ActorAlign.CENTER});
        this._eventTitle = new St.Label({style_class: 'ponyx-event-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._eventMore = new St.Label({style_class: 'ponyx-event-more', y_align: Clutter.ActorAlign.CENTER});
        for (const child of [this._eventDot, this._eventTime, this._eventTitle, this._eventMore])
            this._eventRow.add_child(child);

        this._miniUsage = new St.BoxLayout({style_class: 'ponyx-mini-usage', orientation: Clutter.Orientation.VERTICAL});
        this._miniSession = this._makeUsageRow('Session');
        this._miniWeekly = this._makeUsageRow('Week');
        this._miniStatus = new St.Label({style_class: 'ponyx-status'});
        this._miniUsage.add_child(this._miniSession.row);
        this._miniUsage.add_child(this._miniWeekly.row);
        this._miniUsage.add_child(this._miniStatus);

        calendar.add_child(top);
        calendar.add_child(this._eventRow);
        calendar.add_child(this._miniUsage);
        return calendar;
    }

    _makeUsageRow(label) {
        const row = new St.BoxLayout({style_class: 'ponyx-usage-row'});
        const bar = new UsageBar();
        const pct = new St.Label({style_class: 'ponyx-usage-pct', y_align: Clutter.ActorAlign.CENTER});
        const reset = new St.Label({style_class: 'ponyx-usage-reset', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Label({text: label, style_class: 'ponyx-usage-name', y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(bar);
        row.add_child(pct);
        row.add_child(reset);
        return {row, bar, pct, reset};
    }

    _buildClaudePage() {
        const page = new St.BoxLayout({style_class: 'ponyx-page ponyx-claude-page', x_expand: true, y_expand: true});
        this._sessionCard = this._makeRingCard('Session', '5-hour window');
        this._weeklyCard = this._makeRingCard('This week', 'All models');

        const details = new St.BoxLayout({
            style_class: 'ponyx-details',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._plan = new St.Label({style_class: 'ponyx-plan'});
        this._models = new St.BoxLayout({style_class: 'ponyx-models', orientation: Clutter.Orientation.VERTICAL});
        this._claudeStatus = new St.Label({style_class: 'ponyx-status'});
        this._claudeStatus.clutter_text.line_wrap = true;

        const footer = new St.BoxLayout({style_class: 'ponyx-footer', y_expand: true, y_align: Clutter.ActorAlign.END});
        this._updated = new St.Label({style_class: 'ponyx-updated', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._refreshButton = new St.Button({
            style_class: 'ponyx-pill-button',
            label: 'Refresh',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._refreshButton.connect('clicked', () => this._refreshUsage(true));
        footer.add_child(this._updated);
        footer.add_child(this._refreshButton);

        details.add_child(this._plan);
        details.add_child(this._models);
        details.add_child(this._claudeStatus);
        details.add_child(footer);

        page.add_child(this._sessionCard.card);
        page.add_child(this._weeklyCard.card);
        page.add_child(new St.Widget({style_class: 'ponyx-divider', y_expand: true}));
        page.add_child(details);
        return page;
    }

    _makeRingCard(title, subtitle) {
        const card = new St.BoxLayout({
            style_class: 'ponyx-ring-card',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const wrap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        const ring = new UsageRing('ponyx-ring-large', 6);
        const value = new St.Label({
            style_class: 'ponyx-ring-value',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        wrap.add_child(ring);
        wrap.add_child(value);

        const reset = new St.Label({style_class: 'ponyx-card-sub'});
        card.add_child(wrap);
        card.add_child(new St.Label({text: title, style_class: 'ponyx-card-title'}));
        card.add_child(new St.Label({text: subtitle, style_class: 'ponyx-card-sub'}));
        card.add_child(reset);
        return {card, ring, value, reset};
    }

    _selectTab(name) {
        for (const [key, page] of Object.entries(this._pages)) {
            page.visible = key === name;
            this._tabs[key].checked = key === name;
        }
        this._syncSeekPolling();
    }

    // Geometry and animation

    _sizes() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // With the clock both sides grow to keep it centered; without it only the ticker side needs room.
        const clock = this._settings.get_boolean('show-clock');
        let collapsedWidth = ((clock ? COLLAPSED_CLOCK_WIDTH : COLLAPSED_WIDTH) +
            (this._tickerShown ? (clock ? 2 : 1) * TICKER_SIDE_EXTRA : 0)) * scale;
        // With the clock the notch hugs its content, so there's no spare width to show up as a gap.
        // Both sides take the wider side's width so the clock stays on the center line.
        // Ask the layout directly: the box itself has a fixed size and would report that instead.
        const sides = [this._compactStart, this._compactEnd];
        if (this._compact?.get_stage())
            sides.forEach(side => (side.width = -1));
        if (clock && this._compact?.get_stage()) {
            const side = Math.max(...sides.map(actor => actor.get_preferred_width(-1)[1]));
            sides.forEach(actor => (actor.width = side));
            const [, content] = this._compact.layout_manager.get_preferred_width(this._compact, -1);
            collapsedWidth = Math.ceil(content + this._compact.get_theme_node().get_horizontal_padding());
        }
        return {
            collapsed: [collapsedWidth, Main.panel.height],
            popup: [POPUP_WIDTH * scale, Main.panel.height],
            expanded: [EXPANDED_WIDTH * scale, EXPANDED_HEIGHT * scale],
        };
    }

    _currentSize() {
        const sizes = this._sizes();
        if (this._expanded)
            return sizes.expanded;
        return this._popupShown ? sizes.popup : sizes.collapsed;
    }

    _relayout() {
        const {collapsed, popup, expanded} = this._sizes();
        this._compact.set_size(...collapsed);
        this._notchPopup.box.set_size(...popup);
        this._expandedBox.set_size(...expanded);
        this.actor.remove_all_transitions();
        this._place(...this._currentSize(), false);
    }

    _place(width, height, animate) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const target = {
            x: monitor.x + Math.round((monitor.width - width) / 2),
            y: monitor.y,
            width,
            height,
        };
        if (animate)
            this.actor.ease({...target, duration: RESIZE_MS, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
        else
            this.actor.set(target);
        this._centerChildren();
    }

    _centerChildren() {
        const width = this.actor.width;
        for (const child of [this._compact, this._notchPopup.box, this._expandedBox])
            child.x = Math.round((width - child.width) / 2);
    }

    _onHoverChanged() {
        this._clearHoverTimer();
        let action = null;
        if (this.actor.hover && !this._expanded && this._settings.get_boolean('expand-on-hover'))
            action = [OPEN_DELAY_MS, () => this._open()];
        else if (!this.actor.hover && this._expanded)
            action = [CLOSE_DELAY_MS, () => this._close()];
        if (!action)
            return;

        const [delay, callback] = action;
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverTimer = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHoverTimer() {
        if (this._hoverTimer) {
            GLib.source_remove(this._hoverTimer);
            this._hoverTimer = 0;
        }
    }

    _open() {
        if (this._expanded)
            return;
        this._expanded = true;
        this._hidePopup();
        this.actor.add_style_class_name('expanded');

        // Count failed attempts too, or every hover retries while the API is refusing us.
        if (Date.now() - this._lastAttempt > STALE_AFTER_MS)
            this._refreshUsage();
        this._syncCalendar();
        this._syncEvents();
        this._syncUsage();
        this._syncSeekPolling();

        this._compact.ease({opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._syncTickerMotion();
        this._expandedBox.show();
        this._expandedBox.ease({opacity: 255, duration: 260, delay: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._place(...this._sizes().expanded, true);
    }

    _close() {
        if (!this._expanded)
            return;
        this._hidePopup();
        this._expanded = false;
        this._clearHoverTimer();
        this._syncSeekPolling();
        this.actor.remove_style_class_name('expanded');

        this._expandedBox.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._expanded)
                    this._expandedBox.hide();
            },
        });
        this._compact.ease({opacity: 255, duration: 220, delay: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._syncTickerMotion();
        this._place(...this._sizes().collapsed, true);
    }

    // Pop-ups

    // Shows a short-lived status in the notch, or in the header while the panel is open.
    // Returns false when the island can't be seen, so callers fall back to GNOME's OSD.
    _showPopup({gicon, label = null, level = null, maxLevel = 1, color = '#ffffff'}) {
        if (!this._settings.get_boolean('notch-popups') || !this.actor.visible || Main.sessionMode.isLocked)
            return false;

        const view = this._expanded ? this._headerPopup : this._notchPopup;
        const hasLevel = typeof level === 'number';
        view.icon.gicon = gicon;
        view.label.text = label ?? '';
        view.label.visible = !!label;
        view.label.x_expand = !hasLevel;
        view.bar.visible = view.value.visible = hasLevel;
        if (hasLevel) {
            view.bar.color = color;
            view.bar.percent = clamp(level / (maxLevel > 0 ? maxLevel : 1) * 100, 0, 100);
            view.value.text = `${Math.round(level * 100)}%`;
        }

        if (this._expanded) {
            fadeIn(view.box);
        } else if (!this._popupShown) {
            this._popupShown = true;
            this._compact.ease({opacity: 0, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._syncTickerMotion();
            fadeIn(view.box);
            this._place(...this._sizes().popup, true);
        }

        if (this._popupTimer)
            GLib.source_remove(this._popupTimer);
        this._popupTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_MS, () => {
            this._popupTimer = 0;
            this._hidePopup();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _hidePopup() {
        if (this._popupTimer) {
            GLib.source_remove(this._popupTimer);
            this._popupTimer = 0;
        }
        if (this._headerPopup.box.visible)
            fadeOut(this._headerPopup.box);
        if (!this._popupShown)
            return;
        this._popupShown = false;
        fadeOut(this._notchPopup.box);
        if (!this._expanded) {
            this._compact.ease({opacity: 255, duration: 220, delay: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._syncTickerMotion();
            this._place(...this._sizes().collapsed, true);
        }
    }

    // GNOME routes volume, brightness, mic-mute and headphone OSDs through these three methods.
    _hookOsd() {
        const osd = Main.osdWindowManager;
        const island = this;
        this._osdOriginals = {};
        for (const name of ['show', 'showAll', 'showOne'])
            this._osdOriginals[name] = {fn: osd[name], own: Object.hasOwn(osd, name)};
        const original = name => this._osdOriginals[name].fn;

        osd.showAll = function (icon, label, level, maxLevel) {
            if (!island._showPopup({gicon: icon, label, level, maxLevel}))
                original('showAll').call(this, icon, label, level, maxLevel);
        };
        osd.showOne = function (monitorIndex, icon, label, level, maxLevel) {
            if (monitorIndex !== Main.layoutManager.primaryIndex ||
                !island._showPopup({gicon: icon, label, level, maxLevel}))
                original('showOne').call(this, monitorIndex, icon, label, level, maxLevel);
        };
        osd.show = function (icon, label, levels) {
            const entry = levels?.[Main.layoutManager.primaryIndex] ?? Object.values(levels ?? {})[0];
            if (!island._showPopup({gicon: icon, label, level: entry?.level ?? null, maxLevel: entry?.maxLevel ?? 1}))
                original('show').call(this, icon, label, levels);
        };
    }

    _unhookOsd() {
        const osd = Main.osdWindowManager;
        for (const [name, {fn, own}] of Object.entries(this._osdOriginals ?? {})) {
            if (own)
                osd[name] = fn;
            else
                delete osd[name];
        }
        this._osdOriginals = null;
    }

    _watchPower() {
        UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                if (error || this._destroyed)
                    return;
                this._power = proxy;
                this._plugged = UPOWER_PLUGGED.has(proxy.State);
                proxy.connectObject('g-properties-changed', () => this._onPowerChanged(), this);
            }, this._cancellable);
    }

    _onPowerChanged() {
        const power = this._power;
        if (!power.IsPresent)
            return;
        const plugged = UPOWER_PLUGGED.has(power.State);
        if (plugged === this._plugged)
            return;
        this._plugged = plugged;
        this._showPopup({
            gicon: new Gio.ThemedIcon({name: power.IconName || 'battery-symbolic'}),
            label: plugged ? 'Charging' : 'On battery',
            level: power.Percentage / 100,
            color: plugged ? '#30d158' : '#ffffff',
        });
    }

    // Fires when the output device changes, e.g. Bluetooth headphones connecting.
    _onSinkChanged() {
        const stream = this._mixer.get_default_sink();
        if (!stream)
            return;
        const firstSync = this._sinkId === undefined;
        if (stream.id === this._sinkId)
            return;
        this._sinkId = stream.id;
        if (firstSync)
            return;

        const device = this._mixer.lookup_device_from_stream(stream);
        const formFactor = stream.get_form_factor() ?? '';
        const port = stream.get_port()?.port?.toLowerCase() ?? '';
        const headphones = ['headset', 'headphone'].includes(formFactor) || port.includes('headphone');
        this._showPopup({
            gicon: new Gio.ThemedIcon({name: headphones ? 'audio-headphones-symbolic' : 'audio-speakers-symbolic'}),
            label: device?.description || stream.description,
            level: stream.is_muted ? 0 : stream.volume / this._mixer.get_vol_max_norm(),
        });
    }

    _onScroll(event) {
        if (!this._settings.get_boolean('scroll-volume'))
            return Clutter.EVENT_PROPAGATE;

        let steps = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            steps = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            steps = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            this._scrollDelta -= dy;
            steps = Math.trunc(this._scrollDelta);
            this._scrollDelta -= steps;
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        if (steps)
            this._changeVolume(steps);
        return Clutter.EVENT_STOP;
    }

    _changeVolume(steps) {
        const stream = this._mixer.get_default_sink();
        if (!stream)
            return;
        const max = this._mixer.get_vol_max_norm();
        const current = stream.is_muted ? 0 : stream.volume / max;
        // Never cut a level that was amplified above 100% elsewhere.
        const level = clamp(current + steps * VOLUME_STEP, 0, Math.max(1, current));
        if (stream.is_muted && level > 0)
            stream.change_is_muted(false);
        stream.volume = Math.round(level * max);
        stream.push_volume();
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: volumeIcon(level)}), null, level, Math.max(1, level));
    }

    // Data

    _scheduleRefresh() {
        if (this._refreshTimer)
            GLib.source_remove(this._refreshTimer);
        const seconds = this._settings.get_uint('refresh-minutes') * 60;
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refreshUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Automatic checks that hit a rate limit stay quiet and keep the last reading on screen;
    // only a Refresh click that runs into the limit says so.
    async _refreshUsage(manual = false) {
        if (this._fetching)
            return;
        // Every request during a rate limit extends it, so wait it out, even for the Refresh button.
        if (Date.now() < this._retryAt) {
            if (manual) {
                this._rateLimitNotice = true;
                this._syncUsage();
            }
            return;
        }
        this._fetching = true;
        this._lastAttempt = Date.now();
        this._refreshButton.label = 'Checking…';
        try {
            this._usage = await this._client.fetch(this._cancellable);
            this._usageError = null;
            this._rateLimitNotice = false;
            this._retryAt = 0;
        } catch (e) {
            if (isCancelled(e))
                return;
            this._retryAt = e.retryAt ?? 0;
            if (e.kind === 'rate-limited' && this._usage) {
                this._usageError = null;
                this._rateLimitNotice = manual;
            } else {
                this._usageError = e instanceof UsageError ? e.message : 'Could not load usage';
            }
            if (!(e instanceof UsageError))
                logError(e, 'Ponyx: usage fetch failed');
        } finally {
            this._fetching = false;
        }
        if (this._destroyed)
            return;
        this._refreshButton.label = 'Refresh';
        const cache = serializeUsage(this._usage, this._retryAt);
        if (cache !== this._settings.get_string('usage-cache'))
            this._settings.set_string('usage-cache', cache);
        this._syncUsage();
        if (!this._usageError)
            this._checkUsageAlerts();
    }

    // Alerts once per threshold per usage window; the state survives restarts so a
    // re-login doesn't repeat an alert for a window that was already announced.
    _checkUsageAlerts() {
        if (!this._settings.get_boolean('usage-alerts'))
            return;
        let state;
        try {
            state = JSON.parse(this._settings.get_string('alert-state'));
        } catch {
            state = {};
        }

        let changed = false;
        for (const [name, window] of [['Session', this._usage.session], ['Weekly', this._usage.weekly]]) {
            if (!window)
                continue;
            const key = String(window.resetsAt?.getTime() ?? '');
            const level = ALERT_LEVELS.filter(threshold => window.percent >= threshold).pop() ?? 0;
            const sameWindow = state[name]?.key === key;
            const alerted = sameWindow ? state[name].level : 0;
            if (!sameWindow || level > alerted) {
                state[name] = {key, level: Math.max(level, alerted)};
                changed = true;
            }
            if (level <= alerted)
                continue;

            const resets = window.resetsAt ? `Resets in ${formatCountdown(window.resetsAt)}.` : null;
            Main.notify(`Claude ${name.toLowerCase()} usage at ${window.percent}%`, resets);
            this._showPopup({
                gicon: new Gio.ThemedIcon({name: 'dialog-warning-symbolic'}),
                label: `${name} limit`,
                level: window.percent / 100,
                color: levelColor(window.percent),
            });
        }
        if (changed)
            this._settings.set_string('alert-state', JSON.stringify(state));
    }

    _syncUsage() {
        const usage = this._usage;
        const now = new Date();
        if (this._rateLimitNotice && now >= this._retryAt)
            this._rateLimitNotice = false;
        // At least a minute, so it never reads "try again in 0m".
        const error = this._rateLimitNotice
            ? `Rate limited, try again in ${formatCountdown(new Date(Math.max(this._retryAt, now.getTime() + 60000)), now)}`
            : this._usageError;
        const session = usage?.session;

        this._compactRing.percent = session?.percent ?? null;
        this._compactPct.text = session ? `${session.percent}%` : '–';
        this._setPulse(this._settings.get_boolean('usage-alerts') && (session?.percent ?? 0) >= PULSE_FROM);

        for (const [row, window] of [[this._miniSession, usage?.session], [this._miniWeekly, usage?.weekly]]) {
            row.row.visible = !!window;
            row.bar.percent = window?.percent ?? 0;
            row.pct.text = window ? `${window.percent}%` : '';
            row.reset.text = window?.resetsAt ? `in ${formatCountdown(window.resetsAt, now)}` : '';
        }
        this._miniStatus.text = error ?? (usage ? '' : 'Loading Claude usage…');
        this._miniStatus.visible = !!this._miniStatus.text;

        for (const [card, window] of [[this._sessionCard, usage?.session], [this._weeklyCard, usage?.weekly]]) {
            card.ring.percent = window?.percent ?? null;
            card.value.text = window ? `${window.percent}%` : '–';
            card.reset.text = window?.resetsAt ? `Resets in ${formatCountdown(window.resetsAt, now)}` : '';
        }

        this._plan.text = usage?.plan ?? 'Claude';
        this._models.destroy_all_children();
        for (const model of usage?.models ?? []) {
            const row = this._makeUsageRow(model.label);
            row.bar.percent = model.percent;
            row.pct.text = `${model.percent}%`;
            row.reset.text = model.resetsAt ? `in ${formatCountdown(model.resetsAt, now)}` : '';
            this._models.add_child(row.row);
        }
        this._claudeStatus.text = error ?? '';
        this._claudeStatus.visible = !!error;
        this._updated.text = usage ? `Updated ${formatAgo(usage.fetchedAt, now)}` : '';
    }

    _setPulse(pulse) {
        if (pulse === this._pulsing)
            return;
        this._pulsing = pulse;
        this._compactBadge.remove_all_transitions();
        this._compactBadge.opacity = 255;
        if (pulse) {
            this._compactBadge.ease({
                opacity: 80,
                duration: 900,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true,
                repeatCount: -1,
            });
        }
    }

    _formatTime(dateTime) {
        const twelveHour = this._interfaceSettings.get_string('clock-format') === '12h';
        return dateTime.format(twelveHour ? '%-l:%M %p' : '%H:%M');
    }

    _syncClock() {
        const shown = this._settings.get_boolean('show-clock');
        if (shown)
            this._compact.add_style_class_name('clock');
        else
            this._compact.remove_style_class_name('clock');
        this._compactStart.x_expand = !shown;
        this._compactEnd.x_expand = shown;
        if (shown !== this._compactClock.visible) {
            this._compactClock.visible = shown;
            this._relayout();
        }

        const now = GLib.DateTime.new_now_local();
        this._compactDate.text = now.format('%a %-d %b');
        this._compactTime.text = this._formatTime(now);
        // The date and a 12h time change width, and the notch hugs the clock.
        const [width] = this._sizes().collapsed;
        if (width !== this._collapsedWidth) {
            this._collapsedWidth = width;
            this._relayout();
        }
        // The day strip and the next event roll over on the same minute tick.
        this._syncCalendar();
        this._syncEvents();
    }

    _syncCalendar() {
        const today = GLib.DateTime.new_now_local();
        const key = today.format('%F');
        if (key === this._calendarDay)
            return;
        this._calendarDay = key;

        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        this._eventSource?.requestRange(start, end);

        this._month.text = today.format('%b');
        this._days.destroy_all_children();
        for (let offset = -2; offset <= 2; offset++) {
            const date = today.add_days(offset);
            const day = new St.BoxLayout({style_class: 'ponyx-day', orientation: Clutter.Orientation.VERTICAL});
            if (offset === 0)
                day.add_style_class_name('today');
            else if (date.get_day_of_week() === 7)
                day.add_style_class_name('sunday');
            day.add_child(new St.Label({text: date.format('%a').toUpperCase(), style_class: 'ponyx-day-name'}));
            day.add_child(new St.Label({text: date.format('%d'), style_class: 'ponyx-day-num'}));
            this._days.add_child(day);
        }
    }

    _syncEvents() {
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);

        const isAllDay = event => event.date <= start && event.end >= end;
        const pending = (this._eventSource?.getEvents(start, end) ?? []).filter(event => event.end > now);
        // Timed events are more urgent than all-day ones, so they win the single slot.
        const next = pending.find(event => !isAllDay(event)) ?? pending[0];

        this._eventDot.visible = this._eventTime.visible = !!next;
        this._eventMore.visible = pending.length > 1;
        if (!next) {
            this._eventTitle.text = 'Nothing for today';
            this._eventTitle.add_style_class_name('empty');
            return;
        }

        this._eventTitle.remove_style_class_name('empty');
        this._eventTitle.text = next.summary || 'Untitled event';
        if (isAllDay(next))
            this._eventTime.text = 'All day';
        else if (next.date <= now)
            this._eventTime.text = 'Now';
        else
            this._eventTime.text = this._formatTime(GLib.DateTime.new_from_unix_local(Math.floor(next.date.getTime() / 1000)));
        this._eventMore.text = `+${pending.length - 1}`;
    }

    async _syncMedia() {
        const state = this._media.state;
        this._mediaContent.visible = !!state;
        this._mediaEmpty.visible = !state;
        this._compactArt.visible = !!state;
        this._compactGlyph.visible = !state;
        this._setTicker(state);
        this._syncSeekPolling();
        if (!state) {
            this._syncLyricsTrack(null);
            return;
        }

        this._title.text = state.title;
        this._artist.text = state.artist;
        this._album.text = state.album;
        this._syncLyricsTrack(state);
        this._playIcon.icon_name = state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._previousButton.reactive = state.canPrevious;
        this._nextButton.reactive = state.canNext;
        this._seek.visible = this._elapsed.visible = this._remaining.visible = state.length > 0;
        this._seek.reactive = state.canSeek;

        const app = state.desktopEntry
            ? Shell.AppSystem.get_default().lookup_app(`${state.desktopEntry}.desktop`)
            : null;
        this._appBadge.gicon = app?.get_icon() ?? null;
        this._appBadge.visible = !!app;

        if (state.artUrl === this._artUrl)
            return;
        this._artUrl = state.artUrl;
        this._pollPosition();
        const uri = await this._artCache.resolve(state.artUrl);
        if (this._destroyed || this._artUrl !== state.artUrl)
            return;
        const style = uri ? `background-image: url("${uri.replaceAll('"', '%22')}");` : '';
        this._art.style = style;
        this._compactArt.style = style;
        this._artPlaceholder.visible = !uri;

        const color = await artColor(uri, this._cancellable);
        if (this._destroyed || this._artUrl !== state.artUrl)
            return;
        // Without a cover the stylesheet's default tint applies.
        this._lyricsBox.style = color
            ? `background-color: rgba(${color}, 0.14); border-color: rgba(${color}, 0.16);`
            : '';
    }

    // Position is polled only while the media page is on screen.
    _syncSeekPolling() {
        const wanted = this._expanded && this._pages.music.visible && (this._media.state?.length ?? 0) > 0;
        if (wanted && !this._seekTimer) {
            this._pollPosition();
            this._seekTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_POLL_MS, () => {
                this._pollPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._seekTimer) {
            GLib.source_remove(this._seekTimer);
            this._seekTimer = 0;
        }

        const lyricsWanted = wanted && !!this._lyrics?.synced.length;
        if (lyricsWanted && !this._lyricsTimer) {
            this._lyricsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LYRICS_TICK_MS, () => {
                this._showLyricLine();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!lyricsWanted && this._lyricsTimer) {
            GLib.source_remove(this._lyricsTimer);
            this._lyricsTimer = 0;
        }
    }

    // Fetches lyrics when the track changes; keyed on metadata so pausing or seeking doesn't refetch.
    async _syncLyricsTrack(state) {
        const enabled = this._settings.get_boolean('show-lyrics');
        const key = state && enabled ? JSON.stringify([state.title, state.artist, state.album]) : null;
        if (key !== this._lyricsKey) {
            this._lyricsKey = key;
            this._lyrics = null;
            this._positionSample = null;
            this._showLyrics();
            if (key && state.length > 0) {
                let lyrics = null;
                try {
                    lyrics = await this._lyricsClient.lookup(state, this._cancellable);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                }
                if (this._destroyed || this._lyricsKey !== key)
                    return;
                this._lyrics = lyrics;
                this._showLyrics();
            } else if (key) {
                // Some players fill in the length a moment after the title; try again then.
                this._lyricsKey = null;
            }
        } else if (this._positionSample && this._positionSample.playing !== !!state?.playing) {
            // Play/pause changes where the extrapolated clock should run from.
            this._pollPosition();
        }
        this._syncSeekPolling();
    }

    _showLyrics() {
        const lyrics = this._lyrics;
        const synced = !!lyrics?.synced.length;
        this._lyricsBox.visible = !!lyrics;
        // Lyrics take the album's line; the album is still on the art and in the ticker.
        this._album.visible = !lyrics && !!this._album.text;
        this._syncedBox.visible = synced || !!lyrics?.instrumental && !lyrics.plain;
        this._plainScroll.visible = !this._syncedBox.visible;
        this._lyricsLine = null;
        if (!lyrics)
            return;

        if (synced) {
            this._showLyricLine();
        } else if (lyrics.plain) {
            this._lyricPlain.text = lyrics.plain;
            this._plainScroll.vadjustment.value = 0;
        } else {
            this._lyricNow.text = '♪  Instrumental';
        }
        this._syncSeekPolling();
    }

    _showLyricLine() {
        const lines = this._lyrics?.synced;
        if (!lines?.length)
            return;
        const sample = this._positionSample;
        let position = sample?.position ?? 0;
        if (sample?.playing)
            position += GLib.get_monotonic_time() - sample.at;
        const index = lineAt(lines, position / 1e6);
        if (index === this._lyricsLine)
            return;
        const moved = this._lyricsLine !== null;
        this._lyricsLine = index;

        // Empty lines in LRC mark instrumental breaks.
        this._lyricNow.text = lines[index]?.text || '♪';
        if (moved) {
            this._syncedBox.remove_all_transitions();
            this._syncedBox.set({opacity: 90, translation_y: 6});
            this._syncedBox.ease({opacity: 255, translation_y: 0, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    async _pollPosition() {
        const position = await this._media.position();
        const length = this._media.state?.length ?? 0;
        if (this._destroyed || position === null || !length)
            return;
        this._samplePosition(position);
        if (this._seekDragging)
            return;
        this._seekUpdating = true;
        this._seek.value = clamp(position / length, 0, 1);
        this._seekUpdating = false;
        this._showSeekTimes(position);
    }

    _showSeekTimes(position) {
        const length = this._media.state?.length ?? 0;
        this._elapsed.text = formatDuration(position);
        this._remaining.text = `-${formatDuration(length - position)}`;
    }

    _commitSeek() {
        const length = this._media.state?.length ?? 0;
        if (!length)
            return;
        const position = this._seek.value * length;
        this._media.setPosition(position);
        this._showSeekTimes(position);
        this._samplePosition(position);
    }

    _samplePosition(position) {
        this._positionSample = {position, at: GLib.get_monotonic_time(), playing: !!this._media.state?.playing};
        this._showLyricLine();
    }

    _setClockMoved(moved) {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock)
            return;
        const target = moved ? Main.panel._rightBox : Main.panel._centerBox;
        if (clock.get_parent() === target)
            return;
        clock.get_parent()?.remove_child(clock);
        target.insert_child_at_index(clock, moved ? 0 : this._clockIndex);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._clearHoverTimer();
        if (this._tickerLater)
            global.compositor.get_laters().remove(this._tickerLater);
        for (const id of [this._refreshTimer, this._tickTimer, this._popupTimer, this._seekTimer, this._lyricsTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._unhookOsd();

        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._wallClock.disconnectObject(this);
        // run_dispose() is needed here: GnomeDesktop.WallClock keeps its own update timeout and
        // settings connection until it is disposed. Dropping our reference alone leaves it running
        // until the GC happens to finalize it, so after disable() it would keep waking the shell.
        this._wallClock.run_dispose();
        this._mixer.disconnectObject(this);
        this._power?.disconnectObject(this);
        this._eventSource?.disconnectObject(this);
        this._eventSource?.destroy();
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.panel.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        // Untrack before destroy(): MediaWatcher drops its own handlers, which the tracker would retry.
        this._media.disconnectObject(this);
        this._media.destroy();
        this._artCache.destroy();
        this._lyricsClient.destroy();
        this._client.destroy();

        this._setClockMoved(false);
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;

        this._settings = null;
        this._interfaceSettings = null;
        this._wallClock = null;
        this._mixer = null;
        this._power = null;
        this._eventSource = null;
        this._media = null;
        this._artCache = null;
        this._lyricsClient = null;
        this._client = null;
        this._cancellable = null;
    }
}

export default class PonyxExtension extends Extension {
    enable() {
        this._island = new Island(this);
    }

    disable() {
        this._island?.destroy();
        this._island = null;
    }
}
