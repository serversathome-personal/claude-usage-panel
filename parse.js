// Pure helpers that turn the claude.ai /usage response into what the panel
// shows. Kept free of gi:// imports so they can be unit-tested under node
// (see test/parse.test.mjs; test/fixtures/ holds real responses).
//
// As of October 2026 the response carries two generations of data:
// - `limits`: an array of {kind, group, percent, resets_at, scope, ...}.
//   This is what claude.ai/settings/usage renders, and per-model caps
//   (e.g. "Fable this week") only appear here.
// - legacy top-level keys: `five_hour`, `seven_day`, `seven_day_<model>`
//   (now mostly null), plus internal codename keys such as `iguana_necktie`
//   that are not user-facing limits and must not be shown.

// Field names that have carried the percentage for a limit window.
const PCT_FIELDS = ['utilization', 'percent', 'used_percentage', 'percent_used'];

// Substring → display name. Matched against a legacy key with window
// prefixes stripped, or a model display name, so `seven_day_opus`,
// `opus_5_5` and "Claude Opus 5.5" all land on Opus. `omelette` is
// claude.ai's internal codename for Fable.
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
];

// `limits[].kind` values that duplicate the overall five_hour / seven_day
// windows rather than adding a separate cap.
const OVERALL_KINDS = { session: 'five_hour', weekly_all: 'seven_day' };

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

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
    return { pct: num(v[field]), resets_at: normalizeResets(v.resets_at) };
}

function prettify(s) {
    const words = String(s).replace(/[-_.]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : String(s);
}

// Display name and kind for a legacy key such as `seven_day_opus` or a
// model name such as "Claude Opus 5.5". kind is 'model' for known model
// families, else 'other'.
export function labelFor(key) {
    let k = String(key).toLowerCase();
    for (const [prefix] of WINDOW_PREFIXES) {
        if (k.startsWith(prefix)) { k = k.slice(prefix.length); break; }
    }
    for (const [needle, name] of FAMILIES) {
        const i = k.indexOf(needle);
        if (i < 0) continue;
        const rest = k.slice(i + needle.length);
        const m = rest.match(/^[-_. ]?(\d+(?:[-_. ]\d+)*)/);
        const version = m ? ` ${m[1].replace(/[-_ ]/g, '.')}` : '';
        return { name: `${name}${version}`, kind: 'model' };
    }
    if (PRODUCTS[k]) return { name: PRODUCTS[k], kind: 'other' };
    return { name: prettify(k), kind: 'other' };
}

function scopeName(s) {
    if (typeof s === 'string') return s || null;
    return s?.display_name || s?.name || s?.id || null;
}

function windowOfLimit(item) {
    const g = `${item.group ?? ''} ${item.kind ?? ''}`.toLowerCase();
    if (/week/.test(g)) return '7d';
    if (/session|five_hour/.test(g)) return '5h';
    return null;
}

// Separate caps from the `limits` array (everything except the overall
// session / weekly entries), e.g. "Fable this week".
function fromLimitsArray(arr) {
    const out = [];
    for (const item of Array.isArray(arr) ? arr : []) {
        if (!item || typeof item !== 'object' || OVERALL_KINDS[item.kind])
            continue;
        const model = scopeName(item.scope?.model);
        const surface = scopeName(item.scope?.surface);
        // Display names are shown as given unless they match a model family
        // ("Claude Opus 5.5" → "Opus 5.5").
        const display = n => {
            const l = labelFor(n);
            return l.kind === 'model' ? l.name : n;
        };
        let label;
        if (model) label = { name: display(model), kind: 'model' };
        else if (surface) label = { name: display(surface), kind: 'other' };
        else label = labelFor(item.kind ?? 'limit');
        const win = asWindow(item);
        out.push({
            id: `limits.${item.kind}.${label.name}`,
            ...label,
            window: windowOfLimit(item),
            pct: win?.pct ?? null,
            resets_at: win?.resets_at ?? null,
            active: !!item.is_active,
        });
    }
    return out;
}

// Legacy `seven_day_<model>` / `five_hour_<model>` keys. Null means the cap
// does not apply, so only populated ones are kept. Other top-level keys are
// internal codenames and are ignored.
function fromLegacyKeys(raw) {
    const out = [];
    for (const [k, v] of Object.entries(raw || {})) {
        const prefix = WINDOW_PREFIXES.find(([p]) => k.startsWith(p));
        if (!prefix) continue;
        const win = asWindow(v);
        if (!win || win.pct == null) continue;
        out.push({
            id: k,
            ...labelFor(k),
            window: prefix[1],
            pct: win.pct,
            resets_at: win.resets_at,
            active: false,
        });
    }
    return out;
}

export function collectLimits(raw) {
    const out = fromLimitsArray(raw?.limits);
    const seen = new Set(out.map(l => `${l.name}|${l.window}`));
    for (const l of fromLegacyKeys(raw)) {
        if (!seen.has(`${l.name}|${l.window}`)) out.push(l);
    }
    return out;
}

function overallWindow(raw, key) {
    let w = asWindow(raw?.[key]);
    if (!w || w.pct == null) {
        // Fall back to the matching `limits` entry if the legacy key goes.
        const kind = Object.keys(OVERALL_KINDS).find(k => OVERALL_KINDS[k] === key);
        const item = (Array.isArray(raw?.limits) ? raw.limits : [])
            .find(l => l?.kind === kind);
        w = asWindow(item) ?? w;
    }
    if (!w || (w.pct == null && w.resets_at == null)) return null;
    return w;
}

// Share of this week's usage per product ("Claude Code 87%"), not a limit.
function breakdown(raw) {
    const rows = raw?.seven_day_breakdown?.rows;
    if (!Array.isArray(rows)) return [];
    return rows
        .filter(r => r && num(r.percent) != null)
        .map(r => ({ name: r.display_name || prettify(r.key ?? '?'), pct: r.percent }));
}

function money(m) {
    if (!m || num(m.amount_minor) == null) return null;
    return m.amount_minor / 10 ** (num(m.exponent) ?? 2);
}

// Usage credits ("extra usage"). Prefers the newer `spend` object and falls
// back to `extra_usage`, whose amounts are in minor units (cents) and whose
// utilization is capped at 100% even when spend is past the limit.
export function normalizeCredits(raw) {
    const s = raw?.spend;
    const ex = raw?.extra_usage;
    let c = null;
    if (s && typeof s === 'object') {
        c = {
            enabled: !!s.enabled,
            used: money(s.used),
            limit: money(s.limit),
            currency: s.used?.currency || s.limit?.currency || ex?.currency || null,
            pct: num(s.percent),
            disabled_reason: s.disabled_reason ?? null,
        };
    } else if (ex && typeof ex === 'object') {
        const scale = 10 ** (num(ex.decimal_places) ?? 2);
        c = {
            enabled: !!ex.is_enabled,
            used: num(ex.used_credits) != null ? ex.used_credits / scale : null,
            limit: num(ex.monthly_limit) != null ? ex.monthly_limit / scale : null,
            currency: ex.currency ?? null,
            pct: num(ex.utilization),
            disabled_reason: ex.disabled_reason ?? null,
        };
    }
    if (c && c.used != null && c.limit > 0) c.pct = (c.used / c.limit) * 100;
    return c;
}

export function normalizeUsage(raw) {
    return {
        five_hour: overallWindow(raw, 'five_hour'),
        seven_day: overallWindow(raw, 'seven_day'),
        credits: normalizeCredits(raw),
        limits: collectLimits(raw),
        breakdown: breakdown(raw),
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
