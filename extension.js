import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { CACHE_PATH, fetchUsage, readCache, readRawText } from './fetcher.js';

const HOUR_SLOT_PX = 60;
const WEEK_SLOT_PX = 60;
const BAR_HEIGHT_PX = 8;
const POLL_SECONDS = 60;
// After a 429, skip 1, 2, 4… polls, capped at this many.
const MAX_BACKOFF_POLLS = 16;
// Treat a fetch still pending after this long as stuck.
const FETCH_STUCK_MS = 120 * 1000;

function fmtPct(pct) {
    if (pct == null) return '—';
    return `${Math.round(pct)}%`;
}

function colorForPct(pct) {
    // Two-segment lerp through green → yellow → red so the midpoint is a
    // proper yellow rather than muddy olive.
    const stops = [
        [0,   [ 76, 175,  80]],
        [50,  [253, 216,  53]],
        [100, [229,  57,  53]],
    ];
    const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    let i = 1;
    while (i < stops.length - 1 && p > stops[i][0]) i++;
    const [pA, cA] = stops[i - 1];
    const [pB, cB] = stops[i];
    const t = (p - pA) / (pB - pA);
    const r = Math.round(cA[0] + (cB[0] - cA[0]) * t);
    const g = Math.round(cA[1] + (cB[1] - cA[1]) * t);
    const b = Math.round(cA[2] + (cB[2] - cA[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
}

function fmtMoney(amount, currency) {
    if (amount == null) return '?';
    const sym = currency === 'USD' ? '$' : currency ? `${currency} ` : '';
    return `${sym}${amount.toFixed(2)}`;
}

function fmtCredits(c) {
    if (!c) return 'Usage credits: —';
    if (c.enabled) {
        return `Usage credits: ${fmtMoney(c.used, c.currency)} of ` +
            `${fmtMoney(c.limit, c.currency)} (${fmtPct(c.pct)})`;
    }
    // e.g. "out_of_credits" → "out of credits"
    const why = c.disabled_reason ? String(c.disabled_reason).replace(/_/g, ' ') : '';
    return `Usage credits: off${why ? ` (${why})` : ''}`;
}

function hasData(data) {
    return !!(data && (data.five_hour || data.seven_day));
}

function fmtAge(sec) {
    if (sec < 90) return 'just now';
    if (sec < 5400) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
}

function fmtWindowLine(label, w) {
    const reset = fmtCountdown(w?.resets_at);
    return `${label}: ${fmtPct(w?.pct)}${reset ? ` · resets ${reset}` : ''}`;
}

function fmtCountdown(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const ms = t - Date.now();
    // A reset time already in the past only shows up on stale data; a
    // countdown of "now" there reads as if the data were current.
    if (ms <= 0) return '';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${m}m`;
    return `${m}m`;
}

function makeBarLine(slotWidth) {
    const line = new St.BoxLayout({
        style_class: 'cu-line',
        orientation: Clutter.Orientation.HORIZONTAL,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const trackRow = new St.BoxLayout({
        style_class: 'cu-track-row',
        orientation: Clutter.Orientation.HORIZONTAL,
        width: slotWidth,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const fill = new St.Widget({ style_class: 'cu-fill' });
    fill.width = 0;
    fill.height = BAR_HEIGHT_PX;
    trackRow.add_child(fill);
    const pct = new St.Label({
        text: '—',
        style_class: 'cu-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const reset = new St.Label({
        text: '',
        style_class: 'cu-label-secondary',
        y_align: Clutter.ActorAlign.CENTER,
    });
    line.add_child(trackRow);
    line.add_child(pct);
    line.add_child(reset);
    return { line, fill, pct, reset };
}

function setBar(fill, pct, slotWidth) {
    const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    fill.width = Math.round((clamped / 100) * slotWidth);
    fill.set_style(`background-color: ${colorForPct(pct)};`);
}

// pct ≥ this shows a bar in 'auto' visibility mode.
const AUTO_SHOW_PCT = 50;

function visibleFor(mode, pct) {
    if (mode === 'show') return true;
    if (mode === 'hide') return false;
    return (pct ?? 0) >= AUTO_SHOW_PCT;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Claude Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._lastWeekPct = null;
        // Per-model weekly caps (e.g. Fable) get their own bar, keyed by name.
        this._modelBars = new Map();
        this._settingsChangedIds = [
            this._settings.connect('changed::week-bar-visibility',
                () => this._applyWeekVisibility()),
            this._settings.connect('changed::model-bar-visibility',
                () => this._applyModelBarVisibility()),
        ];

        const box = new St.BoxLayout({
            style_class: 'cu-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const hour = makeBarLine(HOUR_SLOT_PX);
        const week = makeBarLine(WEEK_SLOT_PX);
        this._fillHour = hour.fill;
        this._fillWeek = week.fill;
        this._hourPctLabel = hour.pct;
        this._hourResetLabel = hour.reset;
        this._weekPctLabel = week.pct;
        this._weekResetLabel = week.reset;
        this._weekLine = week.line;
        this._weekLine.visible = false;

        this._box = box;
        box.add_child(hour.line);
        box.add_child(week.line);
        this.add_child(box);

        this._fiveHourItem = new PopupMenu.PopupMenuItem('5-hour: —', { reactive: false });
        this._sevenDayItem = new PopupMenu.PopupMenuItem('7-day: —', { reactive: false });
        this._extraItem    = new PopupMenu.PopupMenuItem('Usage credits: —', { reactive: false });
        this.menu.addMenuItem(this._fiveHourItem);
        this.menu.addMenuItem(this._sevenDayItem);
        this.menu.addMenuItem(this._extraItem);

        this._modelsSubMenu = new PopupMenu.PopupSubMenuMenuItem('Per-model limits');
        this.menu.addMenuItem(this._modelsSubMenu);

        this._breakdownSubMenu = new PopupMenu.PopupSubMenuMenuItem('This week by product');
        this.menu.addMenuItem(this._breakdownSubMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._extension.fetch());
        this.menu.addMenuItem(refresh);

        const settings = new PopupMenu.PopupMenuItem('Settings…');
        settings.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settings);

        const openWeb = new PopupMenu.PopupMenuItem('Open claude.ai/settings/usage');
        openWeb.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(
                'https://claude.ai/settings/usage', null);
        });
        this.menu.addMenuItem(openWeb);

        // Diagnostic for when claude.ai changes the response shape again.
        const copyRaw = new PopupMenu.PopupMenuItem('Copy raw usage response');
        copyRaw.connect('activate', () => {
            const text = readRawText();
            if (!text) {
                Main.notify('Claude Usage', 'No usage response cached yet.');
                return;
            }
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, text);
            Main.notify('Claude Usage', 'Raw usage response copied to clipboard.');
        });
        this.menu.addMenuItem(copyRaw);
    }

    setData(data) {
        this._data = data;
        if (!hasData(data)) {
            this._box.remove_style_class_name('cu-stale');
            this._hourPctLabel.text = '!';
            this._hourResetLabel.text = '';
            this._weekPctLabel.text = '';
            this._weekResetLabel.text = '';
            this._fillHour.width = 0;
            this._fillWeek.width = 0;
            this._lastWeekPct = null;
            this._applyWeekVisibility();
            this._updateModelBars([]);
            this._statusItem.label.text = data?.error
                ? `Error: ${data.error}`
                : 'No data — open Settings to add cookies';
            this._fiveHourItem.label.text = '5-hour: —';
            this._sevenDayItem.label.text = '7-day: —';
            this._extraItem.label.text = 'Usage credits: —';
            this._modelsSubMenu.label.text = 'Per-model limits';
            this._modelsSubMenu.menu.removeAll();
            this._breakdownSubMenu.visible = false;
            return;
        }

        const h = data.five_hour || {};
        const w = data.seven_day || {};

        // A failed poll keeps the last good numbers but dims them.
        if (data.error) this._box.add_style_class_name('cu-stale');
        else this._box.remove_style_class_name('cu-stale');

        this._hourPctLabel.text = fmtPct(h.pct) + (data.error ? ' !' : '');
        const hourReset = fmtCountdown(h.resets_at);
        this._hourResetLabel.text = hourReset ? `· ${hourReset}` : '';
        this._weekPctLabel.text = fmtPct(w.pct);
        const weekReset = fmtCountdown(w.resets_at);
        this._weekResetLabel.text = weekReset ? `· ${weekReset}` : '';

        setBar(this._fillHour, h.pct, HOUR_SLOT_PX);
        setBar(this._fillWeek, w.pct, WEEK_SLOT_PX);
        this._lastWeekPct = w.pct ?? null;
        this._applyWeekVisibility();
        this._updateModelBars(data.limits || []);

        this._fiveHourItem.label.text = fmtWindowLine('5-hour', h);
        this._sevenDayItem.label.text = fmtWindowLine('7-day', w);

        this._extraItem.label.text = fmtCredits(data.credits);

        this._renderLimits(data.limits || []);
        this._renderBreakdown(data.breakdown || []);

        const now = Math.floor(Date.now() / 1000);
        const ageStr = fmtAge(Math.max(0, now - (data.fetched_at ?? 0)));
        this._statusItem.label.text = data.error
            ? `Error: ${data.error} (showing data from ${ageStr})`
            : `Updated ${ageStr}`;
    }

    _renderLimits(limits) {
        const sub = this._modelsSubMenu;
        sub.menu.removeAll();

        const line = l => {
            const name = `${l.name}${l.window === '5h' ? ' (5-hour)' : ''}`;
            if (l.pct == null) return `${name}: —`;
            const reset = fmtCountdown(l.resets_at);
            return `${name}: ${fmtPct(l.pct)}${reset ? ` · resets ${reset}` : ''}`;
        };
        const byPct = (a, b) => (b.pct ?? -1) - (a.pct ?? -1) ||
            a.name.localeCompare(b.name);
        const add = text => sub.menu.addMenuItem(
            new PopupMenu.PopupMenuItem(text, { reactive: false }));

        const models = limits.filter(l => l.kind === 'model').sort(byPct);
        const other = limits.filter(l => l.kind !== 'model').sort(byPct);

        const top = models.find(l => l.pct != null);
        sub.label.text = top
            ? `Per-model limits · ${top.name} ${fmtPct(top.pct)}`
            : 'Per-model limits';

        if (limits.length === 0) {
            add('No separate model limits right now');
            return;
        }
        for (const l of models) add(line(l));
        if (other.length > 0) {
            if (models.length > 0)
                sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const l of other) add(line(l));
        }
    }

    // Share of this week's usage per product; percentages of the week's
    // usage, not of a limit.
    _renderBreakdown(rows) {
        const sub = this._breakdownSubMenu;
        sub.menu.removeAll();
        sub.visible = rows.length > 0;
        for (const r of rows) {
            sub.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `${r.name}: ${fmtPct(r.pct)}`, { reactive: false }));
        }
    }

    _applyWeekVisibility() {
        this._weekLine.visible = visibleFor(
            this._settings.get_string('week-bar-visibility'), this._lastWeekPct);
    }

    // One bar per per-model weekly cap, e.g. "Fable 9% · 6d 4h". Bars for
    // caps that disappear from the response are removed.
    _updateModelBars(limits) {
        const caps = limits.filter(l => l.kind === 'model' && l.window === '7d');
        const names = new Set(caps.map(l => l.name));
        for (const [name, bar] of this._modelBars) {
            if (!names.has(name)) {
                bar.line.destroy();
                this._modelBars.delete(name);
            }
        }
        for (const l of caps) {
            let bar = this._modelBars.get(l.name);
            if (!bar) {
                bar = makeBarLine(WEEK_SLOT_PX);
                this._box.add_child(bar.line);
                this._modelBars.set(l.name, bar);
            }
            bar.lastPct = l.pct ?? null;
            bar.pct.text = `${l.name} ${fmtPct(l.pct)}`;
            const reset = fmtCountdown(l.resets_at);
            bar.reset.text = reset ? `· ${reset}` : '';
            setBar(bar.fill, l.pct, WEEK_SLOT_PX);
        }
        this._applyModelBarVisibility();
    }

    _applyModelBarVisibility() {
        const mode = this._settings.get_string('model-bar-visibility');
        for (const bar of this._modelBars.values())
            bar.line.visible = visibleFor(mode, bar.lastPct);
    }

    destroy() {
        for (const id of this._settingsChangedIds ?? [])
            this._settings.disconnect(id);
        this._settingsChangedIds = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._backoff = 0;
        this._skipPolls = 0;

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        // Warm-start from the on-disk cache so the panel shows last-known
        // values immediately while the first fetch is in flight.
        const cached = readCache();
        if (cached) this._indicator.setData(cached);

        // Watch the cache file so writes from the prefs window land here too.
        this._file = Gio.File.new_for_path(CACHE_PATH);
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', () => this._reload());

        // Re-render countdown labels every 30s even without a new fetch.
        this._uiTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._indicator?.setData(this._indicator._data);
            return GLib.SOURCE_CONTINUE;
        });

        // Drive fetches ourselves: one now, then every POLL_SECONDS, skipping
        // polls while backing off from a 429.
        this.fetch();
        this._fetchTickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                if (this._skipPolls > 0) this._skipPolls--;
                else this.fetch();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        for (const id of ['_uiTickId', '_fetchTickId']) {
            if (this[id]) { GLib.source_remove(this[id]); this[id] = null; }
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = null;
        }
        this._file = null;
        this._fetching = false;
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    fetch() {
        if (!this._cancellable) return;
        // A request that never settles would otherwise block every later
        // poll; Soup's 15s timeout should prevent that, but don't rely on it.
        const now = Date.now();
        if (this._fetching && now - this._fetchStarted < FETCH_STUCK_MS) return;
        this._fetching = true;
        this._fetchStarted = now;
        fetchUsage({
            userAgent: this._settings.get_string('user-agent').trim(),
            cancellable: this._cancellable,
        })
            .then(payload => {
                if (!payload) return;  // cancelled
                if (payload.error_code === 429) {
                    this._backoff = Math.min(
                        Math.max(1, this._backoff * 2), MAX_BACKOFF_POLLS);
                } else {
                    this._backoff = 0;
                }
                this._skipPolls = this._backoff;
                this._indicator?.setData(payload);
            })
            .catch(e => {
                logError(e, 'claude-usage: fetch failed');
                const prev = this._indicator?._data;
                const error = String(e.message || e);
                this._indicator?.setData(
                    hasData(prev) ? { ...prev, error } : { error });
            })
            .finally(() => { this._fetching = false; });
    }

    _reload() {
        if (!this._indicator) return;
        const data = readCache();
        if (data) this._indicator.setData(data);
    }
}
