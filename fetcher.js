import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

const SERVICE = 'claude-usage';
const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const CACHE_PATH = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'claude-usage.json']);

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

function httpJson(url, cookieHeader) {
    return new Promise((resolve, reject) => {
        const msg = Soup.Message.new('GET', url);
        const h = msg.get_request_headers();
        h.append('Cookie', cookieHeader);
        h.append('User-Agent', USER_AGENT);
        h.append('Accept', 'application/json');
        session().send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, null,
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
                    resolve(JSON.parse(text));
                } catch (e) { reject(e); }
            });
    });
}

function pickWindow(raw, key) {
    const v = raw?.[key];
    if (!v || typeof v !== 'object') return null;
    const pct = v.utilization;
    const resets = v.resets_at;
    if (pct == null && resets == null) return null;
    return { pct, resets_at: resets };
}

function writeCache(payload) {
    try {
        const file = Gio.File.new_for_path(CACHE_PATH);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null))
            parent.make_directory_with_parents(null);
        const tmp = Gio.File.new_for_path(`${CACHE_PATH}.tmp`);
        const stream = tmp.replace(null, false, Gio.FileCreateFlags.NONE, null);
        stream.write_all(
            new TextEncoder().encode(JSON.stringify(payload, null, 2)), null);
        stream.close(null);
        tmp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch (e) {
        logError(e, 'claude-usage: writeCache failed');
    }
}

export function readCache() {
    try {
        const file = Gio.File.new_for_path(CACHE_PATH);
        if (!file.query_exists(null)) return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (_) { return null; }
}

export async function fetchUsage() {
    const fetched_at = Math.floor(Date.now() / 1000);

    let sessionKey, cf_clearance;
    try {
        sessionKey = (await lookupSecret('sessionKey')).trim();
        cf_clearance = (await lookupSecret('cf_clearance')).trim();
    } catch (e) {
        const payload = { fetched_at, error: `auth: ${e.message || e}` };
        writeCache(payload);
        return payload;
    }
    if (!sessionKey || !cf_clearance) {
        const payload = { fetched_at, error: 'missing cookies; open Settings' };
        writeCache(payload);
        return payload;
    }

    const cookieHeader = `sessionKey=${sessionKey}; cf_clearance=${cf_clearance}`;

    let raw, org_id;
    try {
        const orgs = await httpJson(
            'https://claude.ai/api/organizations', cookieHeader);
        if (!Array.isArray(orgs) || orgs.length === 0)
            throw new Error('no organizations returned');
        org_id = orgs[0].uuid || orgs[0].id;
        if (!org_id) throw new Error('no org id in organizations response');
        raw = await httpJson(
            `https://claude.ai/api/organizations/${org_id}/usage`,
            cookieHeader);
    } catch (e) {
        let msg = e.message || String(e);
        if (e.code === 403)
            msg = 'http 403 (cf_clearance likely expired; re-paste via Settings)';
        const payload = { fetched_at, error: msg };
        writeCache(payload);
        return payload;
    }

    if (!raw || typeof raw !== 'object') {
        const payload = { fetched_at, error: 'unexpected response' };
        writeCache(payload);
        return payload;
    }

    let extra_norm = null;
    const ex = raw.extra_usage;
    if (ex && typeof ex === 'object') {
        // API returns money in cents and caps utilization at 100% even when
        // actual spend is past the limit. Convert to dollars and recompute
        // the true percentage from used / limit.
        const usedDollars = typeof ex.used_credits === 'number'
            ? ex.used_credits / 100 : null;
        const limitDollars = typeof ex.monthly_limit === 'number'
            ? ex.monthly_limit / 100 : null;
        const truePct = (usedDollars != null && limitDollars && limitDollars > 0)
            ? (usedDollars / limitDollars) * 100
            : ex.utilization;
        extra_norm = {
            pct: truePct,
            used_credits: usedDollars,
            monthly_limit: limitDollars,
            currency: ex.currency,
            is_enabled: ex.is_enabled,
        };
    }

    const models = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('seven_day_') && v && typeof v === 'object') {
            models[k.slice('seven_day_'.length)] = {
                pct: v.utilization,
                resets_at: v.resets_at,
            };
        }
    }

    const payload = {
        fetched_at,
        org_id,
        five_hour: pickWindow(raw, 'five_hour'),
        seven_day: pickWindow(raw, 'seven_day'),
        extra_usage: extra_norm,
        models,
        raw,
    };
    writeCache(payload);
    return payload;
}
