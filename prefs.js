import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    DEFAULT_USER_AGENT, fetchUsage, lookupSecret, storeSecret,
} from './fetcher.js';

const ACCOUNTS = ['sessionKey', 'cf_clearance'];
// Optional: only needed for accounts in more than one organization.
const OPTIONAL_ACCOUNT = 'lastActiveOrg';
const WEEK_VIS_VALUES = ['auto', 'show', 'hide'];
const WEEK_VIS_LABELS = ['Auto', 'Always show', 'Never show'];

export default class ClaudeUsagePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: 'Cookies',
            icon_name: 'dialog-password-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'claude.ai cookies',
            description:
                'Copy from devtools (Storage → Cookies → claude.ai). ' +
                'cf_clearance rotates every few hours/days; re-paste it ' +
                'when the panel shows "!".',
        });
        page.add(group);

        const rows = {};
        for (const account of ACCOUNTS) {
            const row = new Adw.PasswordEntryRow({ title: account });
            group.add(row);
            rows[account] = row;
            lookupSecret(account)
                .then(v => { row.text = (v || '').trim(); })
                .catch(e => logError(e, `claude-usage prefs: lookup ${account}`));
        }

        // Optional org selector. Leave blank unless your account belongs to
        // more than one organization; when set, the fetcher uses the matching
        // org instead of the first one returned by the API.
        const optionalGroup = new Adw.PreferencesGroup({
            title: 'Multiple organizations (optional)',
            description:
                'Only needed if your claude.ai account belongs to more than ' +
                'one organization. Paste the lastActiveOrg cookie to pick which ' +
                'org the panel reports on. Leave blank otherwise.',
        });
        page.add(optionalGroup);

        const optionalRow = new Adw.PasswordEntryRow({
            title: `${OPTIONAL_ACCOUNT} (optional)`,
        });
        optionalGroup.add(optionalRow);
        rows[OPTIONAL_ACCOUNT] = optionalRow;
        lookupSecret(OPTIONAL_ACCOUNT)
            .then(v => { optionalRow.text = (v || '').trim(); })
            .catch(e => logError(e,
                `claude-usage prefs: lookup ${OPTIONAL_ACCOUNT}`));

        const settings = this.getSettings();

        const uaGroup = new Adw.PreferencesGroup({
            title: 'Browser user agent (optional)',
            description:
                'Cloudflare ties cf_clearance to the browser that earned it. ' +
                'If you get HTTP 403 right after pasting a fresh cookie, paste ' +
                'that browser\'s user agent here (run navigator.userAgent in ' +
                'its devtools console). Leave blank for the default.',
        });
        page.add(uaGroup);
        const uaRow = new Adw.EntryRow({ title: 'User-Agent' });
        uaRow.set_tooltip_text(`Default: ${DEFAULT_USER_AGENT}`);
        settings.bind('user-agent', uaRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        uaGroup.add(uaRow);

        const actionGroup = new Adw.PreferencesGroup();
        page.add(actionGroup);

        const status = new Adw.ActionRow({ title: 'Ready', subtitle: '' });
        actionGroup.add(status);

        const saveBtn = new Gtk.Button({
            label: 'Save & refresh',
            css_classes: ['suggested-action', 'pill'],
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
            halign: Gtk.Align.END,
        });
        const btnRow = new Adw.ActionRow();
        btnRow.add_suffix(saveBtn);
        actionGroup.add(btnRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
        });
        page.add(displayGroup);

        const weekRow = new Adw.ComboRow({
            title: '7-day bar',
            subtitle: 'Auto shows the bar when any weekly limit is at or above 50%.',
        });
        const stringList = new Gtk.StringList();
        for (const label of WEEK_VIS_LABELS) stringList.append(label);
        weekRow.model = stringList;
        const initialIdx = WEEK_VIS_VALUES.indexOf(
            settings.get_string('week-bar-visibility'));
        weekRow.selected = initialIdx >= 0 ? initialIdx : 0;
        weekRow.connect('notify::selected', () => {
            const v = WEEK_VIS_VALUES[weekRow.selected];
            if (v) settings.set_string('week-bar-visibility', v);
        });
        displayGroup.add(weekRow);

        saveBtn.connect('clicked', async () => {
            saveBtn.sensitive = false;
            status.title = 'Saving…';
            status.subtitle = '';
            try {
                for (const account of ACCOUNTS) {
                    const v = rows[account].text.trim();
                    if (!v) throw new Error(`${account} is empty`);
                    await storeSecret(account, v);
                }
                // Optional: store only when provided; a blank value is fine
                // and must not block saving the required cookies.
                const optionalVal = rows[OPTIONAL_ACCOUNT].text.trim();
                if (optionalVal)
                    await storeSecret(OPTIONAL_ACCOUNT, optionalVal);
                status.title = 'Saved';
                status.subtitle = 'Fetching…';
                const result = await fetchUsage({
                    userAgent: settings.get_string('user-agent').trim(),
                });
                if (!result || result.error) {
                    status.title = 'Saved, but fetch failed';
                    status.subtitle = result?.error ?? 'cancelled';
                } else {
                    status.title = 'Saved & refreshed';
                    status.subtitle = 'Check the panel widget.';
                }
            } catch (e) {
                status.title = 'Save failed';
                status.subtitle = String(e.message || e);
                logError(e, 'claude-usage prefs: save failed');
            } finally {
                saveBtn.sensitive = true;
            }
        });
    }
}
