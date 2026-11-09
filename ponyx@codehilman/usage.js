import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

const MODEL_WINDOWS = [
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
];

const PLAN_NAMES = {pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise'};

// Used when a 429 comes without a usable Retry-After header.
const DEFAULT_RETRY_AFTER_S = 5 * 60;

export class UsageError extends Error {
    constructor(kind, message, retryAt = null) {
        super(message);
        this.kind = kind;
        this.retryAt = retryAt;
    }
}

// Retry-After is either delta-seconds or an HTTP date.
function parseRetryAfter(value, now = Date.now()) {
    const seconds = Number(value);
    if (value && Number.isFinite(seconds))
        return now + Math.max(0, seconds) * 1000;
    const date = value ? Date.parse(value) : NaN;
    return Number.isFinite(date) && date > now ? date : now + DEFAULT_RETRY_AFTER_S * 1000;
}

// The file is owned by Claude Code, which rotates the token itself.
// We only ever read it; writing a refreshed token here could race with Claude Code.
async function readCredentials(cancellable) {
    let contents;
    try {
        [contents] = await Gio.File.new_for_path(CREDENTIALS_PATH).load_contents_async(cancellable);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        throw new UsageError('signed-out', 'Sign in by running claude');
    }

    let oauth;
    try {
        oauth = JSON.parse(new TextDecoder().decode(contents)).claudeAiOauth;
    } catch {
        throw new UsageError('signed-out', 'Credentials file is unreadable');
    }
    if (!oauth?.accessToken)
        throw new UsageError('signed-out', 'Sign in by running claude');

    return {
        token: oauth.accessToken,
        expiresAt: oauth.expiresAt ?? 0,
        plan: PLAN_NAMES[oauth.subscriptionType] ?? 'Claude',
    };
}

function parseWindow(raw) {
    if (raw?.utilization === null || raw?.utilization === undefined)
        return null;
    return {
        percent: Math.max(0, Math.min(100, Math.round(raw.utilization))),
        resetsAt: raw.resets_at ? new Date(raw.resets_at) : null,
    };
}

export function parseUsage(json) {
    const models = [];
    for (const [key, label] of MODEL_WINDOWS) {
        const window = parseWindow(json[key]);
        if (window)
            models.push({label, ...window});
    }
    return {
        session: parseWindow(json.five_hour),
        weekly: parseWindow(json.seven_day),
        models,
    };
}

// The last good reading is kept in GSettings so a restart (or a re-login during a rate limit)
// shows real numbers instead of an empty panel. Dates round-trip as ISO strings.
export function serializeUsage(usage, retryAt = 0) {
    return JSON.stringify({usage, retryAt});
}

export function restoreUsage(text) {
    let cached;
    try {
        cached = JSON.parse(text);
    } catch {
        return {usage: null, retryAt: 0};
    }
    const date = value => value ? new Date(value) : null;
    const window = raw => raw ? {...raw, resetsAt: date(raw.resetsAt)} : null;
    const raw = cached?.usage;
    const usage = raw?.fetchedAt ? {
        session: window(raw.session),
        weekly: window(raw.weekly),
        models: (raw.models ?? []).map(window),
        plan: raw.plan ?? 'Claude',
        fetchedAt: new Date(raw.fetchedAt),
    } : null;
    return {usage, retryAt: Number(cached?.retryAt) || 0};
}

export function formatCountdown(date, now = new Date()) {
    if (!date)
        return '';
    const minutes = Math.max(0, Math.round((date - now) / 60000));
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatAgo(date, now = new Date()) {
    const seconds = Math.round((now - date) / 1000);
    if (seconds < 60)
        return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session({timeout: 20, user_agent: 'ponyx-gnome-extension'});
    }

    async fetch(cancellable = null) {
        const credentials = await readCredentials(cancellable);
        if (credentials.expiresAt && credentials.expiresAt < Date.now())
            throw new UsageError('expired', 'Token expired, run claude to refresh');

        const message = Soup.Message.new('GET', USAGE_URL);
        message.request_headers.append('Authorization', `Bearer ${credentials.token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        message.request_headers.append('Accept', 'application/json');

        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new UsageError('network', 'Offline, will retry');
        }

        // get_status() converts to Soup.Status, which has no 429 and throws; status_code is the raw number.
        const status = message.status_code;
        if (status === 401 || status === 403)
            throw new UsageError('expired', 'Token expired, run claude to refresh');
        if (status === 429) {
            const retryAt = parseRetryAfter(message.response_headers.get_one('Retry-After'));
            throw new UsageError('rate-limited', 'Rate limited, will retry', retryAt);
        }
        if (status !== 200)
            throw new UsageError('http', `Usage request failed (HTTP ${status})`);

        let json;
        try {
            json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw new UsageError('http', 'Unexpected response from Anthropic');
        }

        return {...parseUsage(json), plan: credentials.plan, fetchedAt: new Date()};
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
