// Pure helpers that turn the claude.ai /usage response into what the panel
// shows. Kept free of gi:// imports so they can be unit-tested under node
// (see test/parse.test.mjs).

// Keys rendered by dedicated rows rather than the per-model list.
const HANDLED_KEYS = new Set(['five_hour', 'seven_day', 'extra_usage']);

// Field names that have carried the percentage for a limit window.
const PCT_FIELDS = ['utilization', 'used_percentage', 'percent_used', 'usage_percent'];

// Substring → display name. Matched against the key with window prefixes
// stripped, so `seven_day_opus`, `opus_5_5` and `claude-opus-5-5` all land on
// Opus. `omelette` is claude.ai's internal codename for Fable.
const FAMILIES = [
    ['fable',    'Fable'],
    ['omelette', 'Fable'],
    ['opus',     'Opus'],
    ['sonnet',   'Sonnet'],
    ['haiku',    'Haiku'],
];

// Limits that are per-product rather than per-model.
const PRODUCTS = {
    oauth_apps:  'OAuth apps',
    cowork:      'Cowork',
    claude_code: 'Claude Code',
};

const WINDOW_PREFIXES = [
    ['seven_day_', '7d'],
    ['five_hour_', '5h'],
    ['weekly_',    '7d'],
];

function normalizeResets(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
        // Seconds or milliseconds since the epoch.
        return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    }
    return String(v);
}

// Returns { pct, resets_at } when `v` looks like a limit window, else null.
export function asWindow(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const field = PCT_FIELDS.find(f => f in v);
    if (!field && !('resets_at' in v)) return null;
    const pct = typeof v[field] === 'number' ? v[field] : null;
    return { pct, resets_at: normalizeResets(v.resets_at) };
}

function windowOf(path) {
    const p = path.toLowerCase();
    if (/seven_day|weekly|week/.test(p)) return '7d';
    if (/five_hour|session/.test(p)) return '5h';
    return null;
}

function prettify(s) {
    const words = s.replace(/[-_.]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : s;
}

// Display name and kind for a limit key such as `seven_day_opus` or
// `opus_5_5`. kind is 'model' for known model families, else 'other'.
export function labelFor(key) {
    let k = String(key).toLowerCase();
    for (const [prefix] of WINDOW_PREFIXES) {
        if (k.startsWith(prefix)) { k = k.slice(prefix.length); break; }
    }
    for (const [needle, name] of FAMILIES) {
        const i = k.indexOf(needle);
        if (i < 0) continue;
        const rest = k.slice(i + needle.length);
        const m = rest.match(/^[-_.]?(\d+(?:[-_.]\d+)*)/);
        const version = m ? ` ${m[1].replace(/[-_]/g, '.')}` : '';
        return { name: `${name}${version}`, kind: 'model' };
    }
    if (PRODUCTS[k]) return { name: PRODUCTS[k], kind: 'other' };
    return { name: prettify(k), kind: 'other' };
}

function nameOfItem(item) {
    for (const f of ['model', 'name', 'id', 'type', 'label', 'key']) {
        if (typeof item?.[f] === 'string' && item[f]) return item[f];
    }
    return null;
}

// Walks the response for every limit window other than the top-level 5-hour
// and 7-day ones. Copes with the historical flat layout
// (`seven_day_opus: {utilization, resets_at}`), keys that read null until a
// model is used, and nested objects or arrays of limits.
export function collectLimits(raw) {
    const out = [];
    const seen = new Set();

    const push = (path, nameKey, win) => {
        if (seen.has(path)) return;
        seen.add(path);
        const { name, kind } = labelFor(nameKey);
        out.push({
            id: path,
            name,
            kind,
            window: windowOf(path),
            pct: win?.pct ?? null,
            resets_at: win?.resets_at ?? null,
            unused: !win || win.pct == null,
        });
    };

    const walk = (value, path, nameKey, depth) => {
        if (depth > 3 || value == null || typeof value !== 'object') return;
        const win = asWindow(value);
        if (win) { push(path, nameKey, win); return; }
        if (Array.isArray(value)) {
            value.forEach((item, i) => {
                const n = nameOfItem(item);
                // An item may name its own window, e.g. {window: 'five_hour'}.
                const w = ['window', 'period'].map(f => item?.[f])
                    .find(v => typeof v === 'string');
                const id = `${w ? `${w}:` : ''}${n ?? i}`;
                walk(item, `${path}[${id}]`, n ?? `${nameKey}_${i}`, depth + 1);
            });
            return;
        }
        for (const [k, v] of Object.entries(value))
            walk(v, `${path}.${k}`, k, depth + 1);
    };

    for (const [k, v] of Object.entries(raw || {})) {
        if (HANDLED_KEYS.has(k)) continue;
        // A null `seven_day_<model>` means the limit exists but hasn't been
        // touched this window; show it as unused rather than dropping it.
        if (v == null) {
            if (WINDOW_PREFIXES.some(([p]) => k.startsWith(p))) push(k, k, null);
            continue;
        }
        walk(v, k, k, 0);
    }
    return out;
}

function pickWindow(raw, key) {
    const w = asWindow(raw?.[key]);
    if (!w || (w.pct == null && w.resets_at == null)) return null;
    return w;
}

function normalizeExtra(ex) {
    if (!ex || typeof ex !== 'object') return null;
    // API returns money in cents and caps utilization at 100% even when
    // actual spend is past the limit. Convert to dollars and recompute the
    // true percentage from used / limit.
    const used = typeof ex.used_credits === 'number' ? ex.used_credits / 100 : null;
    const limit = typeof ex.monthly_limit === 'number' ? ex.monthly_limit / 100 : null;
    const pct = (used != null && limit && limit > 0)
        ? (used / limit) * 100
        : ex.utilization ?? null;
    return {
        pct,
        used_credits: used,
        monthly_limit: limit,
        currency: ex.currency,
        is_enabled: ex.is_enabled,
    };
}

export function normalizeUsage(raw) {
    return {
        five_hour: pickWindow(raw, 'five_hour'),
        seven_day: pickWindow(raw, 'seven_day'),
        extra_usage: normalizeExtra(raw?.extra_usage),
        limits: collectLimits(raw),
    };
}

export function orgIdOf(org) {
    return org?.uuid || org?.id || null;
}

// lastActiveOrg wins when it matches; otherwise prefer an org with the chat
// capability (the claude.ai subscription) over API-only Console orgs.
export function pickOrg(orgs, preferred) {
    if (!Array.isArray(orgs) || orgs.length === 0) return null;
    if (preferred) {
        const match = orgs.find(o => orgIdOf(o) === preferred);
        if (match) return match;
    }
    const chat = orgs.find(o =>
        Array.isArray(o?.capabilities) && o.capabilities.includes('chat'));
    return chat || orgs[0];
}
