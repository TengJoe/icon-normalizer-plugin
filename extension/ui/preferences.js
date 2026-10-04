// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import {initLanguage, getLanguage, t} from '../lib/i18n.js';
import {ensureCss, translateWidgetTree} from '../lib/uiCommon.js';
import {AppsPage} from './appsPage.js';
import {RulesPage} from './rulesPage.js';
import {MaintenancePage} from './maintenancePage.js';

export function buildPreferences(window, {controlPath, settings}) {
    initLanguage(settings, GLib.get_language_names());
    window.set_size_request(getLanguage() === 'en' ? 420 : 380, 420);
    ensureCss(import.meta.url, '../preferences.css');
    window.set_title(t('图标统一'));
    const rules = new RulesPage(controlPath, window);
    const apps = new AppsPage(controlPath, window, settings);
    const maint = new MaintenancePage(controlPath, window, settings);
    window.add(rules.page); window.add(apps.page); window.add(maint.page);
    const pages = {rules, apps, maint};
    apps.onScan = async envelope => {
        await rules.refresh(envelope);
        apps.setPolicy(envelope.ok && envelope.result.revision === rules._loadedRevision
            ? rules._savedPolicy : null);
    };
    rules.onSaved = () => { apps.refresh(); maint.refresh(); };
    maint.refresh();
    pages.ready = Promise.all([apps.refresh(), rules._profiles.ready]);
    let changeId = 0;
    const handler = settings.connect('changed::ui-language', () => {
        if (changeId) return;
        // The selection signal is still on the ComboRow's native stack. Do not
        // replace its model until that signal has returned to GTK.
        changeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            changeId = 0;
            initLanguage(settings, GLib.get_language_names());
            window.set_size_request(getLanguage() === 'en' ? 420 : 380, 420);
            translateWidgetTree(window);
            window.set_title(t('图标统一'));
            apps._render();
            rules._profiles.retranslate();
            maint.retranslate();
            return GLib.SOURCE_REMOVE;
        });
    });
    window.connect('close-request', () => {
        if (changeId) { GLib.source_remove(changeId); changeId = 0; }
        settings.disconnect(handler); return false;
    });
    return pages;
}
