import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { fetchUsage, readCache } from './fetcher.js';

const CACHE_PATH = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage.json']);
const HOUR_SLOT_PX = 60;
const WEEK_SLOT_PX = 60;
const BAR_HEIGHT_PX = 8;
const POLL_SECONDS = 60;

// Codename → display name. Anything not listed is collapsed under "Other".
const KNOWN_MODELS = {
    'sonnet': 'Sonnet',
    'opus':   'Opus',
    'haiku':  'Haiku',
};

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

function fmtCountdown(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const ms = t - Date.now();
    if (ms <= 0) return 'now';
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${m}m`;
    return `${m}m`;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Claude Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._lastWeekPct = null;
        this._settingsChangedId = this._settings.connect(
            'changed::week-bar-visibility',
            () => this._applyWeekVisibility());

        const box = new St.BoxLayout({
            style_class: 'cu-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const makeBarLine = (slotWidth) => {
            const line = new St.BoxLayout({
                style_class: 'cu-line',
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const trackRow = new St.BoxLayout({
                style_class: 'cu-track-row',
                vertical: false,
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
        };

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

        box.add_child(hour.line);
        box.add_child(week.line);
        this.add_child(box);

        this._fiveHourItem = new PopupMenu.PopupMenuItem('5-hour: —', { reactive: false });
        this._sevenDayItem = new PopupMenu.PopupMenuItem('7-day: —', { reactive: false });
        this._extraItem    = new PopupMenu.PopupMenuItem('Extra usage: —', { reactive: false });
        this.menu.addMenuItem(this._fiveHourItem);
        this.menu.addMenuItem(this._sevenDayItem);
        this.menu.addMenuItem(this._extraItem);

        this._modelsSubMenu = new PopupMenu.PopupSubMenuMenuItem('Per-model (7-day)');
        this.menu.addMenuItem(this._modelsSubMenu);

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
    }

    setData(data) {
        if (!data || data.error) {
            this._hourPctLabel.text = '!';
            this._hourResetLabel.text = '';
            this._weekPctLabel.text = '';
            this._weekResetLabel.text = '';
            this._fillHour.width = 0;
            this._fillWeek.width = 0;
            this._lastWeekPct = null;
            this._applyWeekVisibility();
            this._statusItem.label.text = data?.error
                ? `Error: ${data.error}`
                : 'No data — open Settings to add cookies';
            this._fiveHourItem.label.text = '5-hour: —';
            this._sevenDayItem.label.text = '7-day: —';
            this._extraItem.label.text = 'Extra usage: —';
            this._modelsSubMenu.menu.removeAll();
            return;
        }

        const h = data.five_hour || {};
        const w = data.seven_day || {};
        const ex = data.extra_usage || {};

        this._hourPctLabel.text = fmtPct(h.pct);
        this._hourResetLabel.text = h.resets_at
            ? `· ${fmtCountdown(h.resets_at)}`
            : '';
        this._weekPctLabel.text = fmtPct(w.pct);
        this._weekResetLabel.text = w.resets_at
            ? `· ${fmtCountdown(w.resets_at)}`
            : '';

        const setBar = (fill, pctVal, slotWidth) => {
            const clamped = pctVal == null ? 0 : Math.max(0, Math.min(100, pctVal));
            fill.width = Math.round((clamped / 100) * slotWidth);
            fill.set_style(`background-color: ${colorForPct(pctVal)};`);
        };
        setBar(this._fillHour, h.pct, HOUR_SLOT_PX);
        setBar(this._fillWeek, w.pct, WEEK_SLOT_PX);
        this._lastWeekPct = w.pct ?? null;
        this._applyWeekVisibility();

        this._fiveHourItem.label.text =
            `5-hour: ${fmtPct(h.pct)} · resets ${fmtCountdown(h.resets_at)}`;
        this._sevenDayItem.label.text =
            `7-day: ${fmtPct(w.pct)} · resets ${fmtCountdown(w.resets_at)}`;

        if (ex && ex.is_enabled && ex.used_credits != null) {
            const cur = ex.currency === 'USD' ? '$' : (ex.currency || '');
            const used = ex.used_credits.toFixed(2);
            const limit = ex.monthly_limit != null
                ? ex.monthly_limit.toFixed(2) : '?';
            this._extraItem.label.text =
                `Extra usage: ${cur}${used} of ${cur}${limit} (${fmtPct(ex.pct)})`;
        } else {
            this._extraItem.label.text = 'Extra usage: disabled';
        }

        this._modelsSubMenu.menu.removeAll();
        const known = [];
        let otherCount = 0, otherMax = -1;
        for (const [key, v] of Object.entries(data.models || {})) {
            if (!v || v.pct == null) continue;
            const friendly = KNOWN_MODELS[key];
            if (friendly) known.push([friendly, v.pct]);
            else { otherCount++; if (v.pct > otherMax) otherMax = v.pct; }
        }
        known.sort((a, b) => b[1] - a[1]);
        if (known.length === 0 && otherCount === 0) {
            this._modelsSubMenu.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('(none)', { reactive: false }));
        } else {
            for (const [name, pct] of known) {
                this._modelsSubMenu.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(`${name}: ${fmtPct(pct)}`,
                        { reactive: false }));
            }
            if (otherCount > 0) {
                const label = otherCount === 1
                    ? `Other: ${fmtPct(otherMax)}`
                    : `Other (${otherCount}): ${fmtPct(otherMax)}`;
                this._modelsSubMenu.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(label, { reactive: false }));
            }
        }

        const ageSec = Math.max(0,
            Math.floor(Date.now() / 1000) - (data.fetched_at ?? 0));
        const ageStr = ageSec < 90 ? 'just now' : `${Math.floor(ageSec / 60)}m ago`;
        this._statusItem.label.text = `Updated ${ageStr}`;
    }

    _applyWeekVisibility() {
        const mode = this._settings.get_string('week-bar-visibility');
        let visible;
        if (mode === 'show') visible = true;
        else if (mode === 'hide') visible = false;
        else visible = (this._lastWeekPct ?? 0) >= 50;
        this._weekLine.visible = visible;
    }

    destroy() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
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
            this._reload();
            return GLib.SOURCE_CONTINUE;
        });

        // Drive fetches ourselves: one now, then every POLL_SECONDS.
        this.fetch();
        this._fetchTickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                this.fetch();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        for (const id of ['_uiTickId', '_fetchTickId']) {
            if (this[id]) { GLib.source_remove(this[id]); this[id] = null; }
        }
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
    }

    fetch() {
        if (this._fetching) return;
        this._fetching = true;
        fetchUsage()
            .then(payload => this._indicator?.setData(payload))
            .catch(e => {
                logError(e, 'claude-usage: fetch failed');
                this._indicator?.setData({ error: String(e.message || e) });
            })
            .finally(() => { this._fetching = false; });
    }

    _reload() {
        if (!this._indicator) return;
        const data = readCache();
        this._indicator.setData(data);
    }
}
