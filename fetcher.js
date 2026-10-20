import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

import { normalizeUsage, orgIdOf, pickOrg } from './parse.js';

const SERVICE = 'claude-usage';
// cf_clearance is bound to the browser that earned it, so users whose browser
// differs can override this via the user-agent setting.
export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
export const CACHE_PATH = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'claude-usage.json']);
// Last raw /usage response, kept separately so the menu's "Copy raw
// response" item can show exactly what claude.ai returned when the API shape
// changes. Holds percentages and timestamps only; cookies never touch disk.
export const RAW_PATH = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'claude-usage-raw.json']);

// SchemaFlags.NONE => attribute-only matching, so entries previously stored
// by `secret-tool store service=claude-usage account=...` are findable
// regardless of which schema name they were filed under.
export const SECRET_SCHEMA = new Secret.Schema(
    'org.local.claude-usage',
    Secret.SchemaFlags.NONE,
    {
        service: Secret.SchemaAttributeType.STRING,
        account: Secret.SchemaAttributeType.STRING,
    });

export function lookupSecret(account) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(
            SECRET_SCHEMA,
            { service: SERVICE, account },
            null,
            (_src, res) => {
                try { resolve(Secret.password_lookup_finish(res) || ''); }
                catch (e) { reject(e); }
            });
    });
}

export function storeSecret(account, value) {
    return new Promise((resolve, reject) => {
        Secret.password_store(
            SECRET_SCHEMA,
            { service: SERVICE, account },
            Secret.COLLECTION_DEFAULT,
            `claude.ai ${account} (claude-usage-panel)`,
            value,
            null,
            (_src, res) => {
                try {
                    if (Secret.password_store_finish(res)) resolve();
                    else reject(new Error('libsecret store returned false'));
                } catch (e) { reject(e); }
            });
    });
}

let _session = null;
function session() {
    if (!_session) _session = new Soup.Session({ timeout: 15 });
    return _session;
}

function httpJson(url, cookieHeader, userAgent, cancellable) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        const h = msg.get_request_headers();
        h.append('Cookie', cookieHeader);
        h.append('User-Agent', userAgent || DEFAULT_USER_AGENT);
        h.append('Accept', 'application/json');
        session().send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable ?? null,
            (src, res) => {
                try {
                    const bytes = src.send_and_read_finish(res);
                    const status = msg.get_status();
                    if (status !== Soup.Status.OK) {
                        const err = new Error(`http ${status}`);
                        err.code = status;
                        return reject(err);
                    }
                    const text = new TextDecoder().decode(bytes.get_data());
                    try {
                        resolve(JSON.parse(text));
                    } catch (_) {
                        // Cloudflare challenge pages come back as HTML.
                        reject(new Error(text.trimStart().startsWith('<')
                            ? 'got HTML instead of JSON (Cloudflare challenge? re-paste cf_clearance)'
                            : 'response was not valid JSON'));
                    }
                } catch (e) { reject(e); }
            });
    });
}

function writeJson(path, payload) {
    try {
        const file = Gio.File.new_for_path(path);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null))
            parent.make_directory_with_parents(null);
        const tmp = Gio.File.new_for_path(`${path}.tmp`);
        const stream = tmp.replace(null, false, Gio.FileCreateFlags.NONE, null);
        stream.write_all(
            new TextEncoder().encode(JSON.stringify(payload, null, 2)), null);
        stream.close(null);
        tmp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch (e) {
        logError(e, `claude-usage: write ${path} failed`);
    }
}

function readJson(path) {
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (_) { return null; }
}

export function readCache() {
    return readJson(CACHE_PATH);
}

export function readRawText() {
    const raw = readJson(RAW_PATH);
    return raw ? JSON.stringify(raw, null, 2) : null;
}

function hasData(p) {
    return !!(p && (p.five_hour || p.seven_day));
}

// On failure keep the last good numbers on screen, flagged as stale, rather
// than blanking the panel over one bad poll.
function failure(fetched_at, error, code = null) {
    const prev = readCache();
    const payload = hasData(prev)
        ? { ...prev, error, error_code: code, error_at: fetched_at }
        : { fetched_at, error, error_code: code };
    writeJson(CACHE_PATH, payload);
    return payload;
}

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Org lookups are cached per (sessionKey, lastActiveOrg) so each poll costs
// one request instead of two. Any failure on /usage drops the cache.
let _org = { key: null, id: null };

// opts: { userAgent, cancellable }. Resolves to null when cancelled.
export async function fetchUsage(opts = {}) {
    const { userAgent = '', cancellable = null } = opts;
    const fetched_at = Math.floor(Date.now() / 1000);

    let sessionKey, cf_clearance;
    try {
        sessionKey = (await lookupSecret('sessionKey')).trim();
        cf_clearance = (await lookupSecret('cf_clearance')).trim();
    } catch (e) {
        return failure(fetched_at, `auth: ${e.message || e}`);
    }
    if (!sessionKey || !cf_clearance)
        return failure(fetched_at, 'missing cookies; open Settings');

    const cookieHeader = `sessionKey=${sessionKey}; cf_clearance=${cf_clearance}`;

    // lastActiveOrg is optional and only matters for accounts that belong to
    // more than one organization. Absence is normal and must not block a
    // fetch, so any error here is swallowed.
    let lastActiveOrg = '';
    try {
        lastActiveOrg = (await lookupSecret('lastActiveOrg')).trim();
    } catch (_) {
        lastActiveOrg = '';
    }

    const orgKey = `${sessionKey}\n${lastActiveOrg}`;
    let raw, org_id;
    try {
        if (_org.key === orgKey && _org.id) {
            org_id = _org.id;
        } else {
            const orgs = await httpJson('https://claude.ai/api/organizations',
                cookieHeader, userAgent, cancellable);
            const chosen = pickOrg(orgs, lastActiveOrg);
            if (!chosen) throw new Error('no organizations returned');
            org_id = orgIdOf(chosen);
            if (!org_id) throw new Error('no org id in organizations response');
            _org = { key: orgKey, id: org_id };
        }
        raw = await httpJson(
            `https://claude.ai/api/organizations/${org_id}/usage`,
            cookieHeader, userAgent, cancellable);
    } catch (e) {
        if (isCancelled(e)) return null;
        _org = { key: null, id: null };
        let msg = e.message || String(e);
        if (e.code === 403)
            msg = 'http 403 (cf_clearance expired or user agent mismatch; re-paste via Settings)';
        else if (e.code === 401)
            msg = 'http 401 (sessionKey expired; re-login to claude.ai and re-copy cookies)';
        else if (e.code === 429)
            msg = 'http 429 (rate limited; backing off)';
        return failure(fetched_at, msg, e.code ?? null);
    }

    if (!raw || typeof raw !== 'object')
        return failure(fetched_at, 'unexpected response');

    writeJson(RAW_PATH, raw);
    const payload = { fetched_at, org_id, ...normalizeUsage(raw) };
    writeJson(CACHE_PATH, payload);
    return payload;
}
