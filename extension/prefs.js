// SPDX-License-Identifier: GPL-3.0-or-later
// Extension preferences entry (GNOME 51 ESM).
import {t} from './shared/i18n.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPreferences} from './prefs/preferences.js';
import {setLocalBackend, hasLocalBackend} from './shared/backendClient.js';
import {LocalControl} from './lib/control.js';

export default class IconNormalizerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_title(t('图标统一'));
        window.set_default_size(960, 760);
        window.set_size_request(380, 420);
        if (!hasLocalBackend()) {
            const desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const control = new LocalControl({
                home: GLib.get_home_dir(),
                // Live main loop: cross-process lock + idle slicing, matching
                // the Shell side, so prefs and Shell serialize on sync.lock.
                locking: true,
                slicing: true,
                settings: {
                    desktop: () => GLib.getenv('XDG_CURRENT_DESKTOP') || 'GNOME',
                    iconTheme: () => desktopSettings.get_string('icon-theme'),
                    automatic: () => null,
                    setTheme: name => desktopSettings.set_string('icon-theme', name),
                },
            });
            setLocalBackend((operation, args) => control.handle(operation, args));
        }
        buildPreferences(window, {controlPath: null, settings: this.getSettings()});
    }
}
