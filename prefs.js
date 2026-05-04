import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { lookupSecret, storeSecret, fetchUsage } from './fetcher.js';

const ACCOUNTS = ['sessionKey', 'cf_clearance'];

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
                status.title = 'Saved';
                status.subtitle = 'Fetching…';
                const result = await fetchUsage();
                if (result?.error) {
                    status.title = 'Saved, but fetch failed';
                    status.subtitle = result.error;
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
