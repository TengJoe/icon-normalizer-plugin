// SPDX-License-Identifier: GPL-3.0-or-later
// Extension preferences entry (GNOME 51 ESM).
import {t} from './shared/i18n.js';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPreferences} from './prefs/preferences.js';

const CONTROL_PATH_PARTS = ['.local', 'libexec', 'icon-normalizer', 'control.py'];

export default class IconNormalizerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_title(t('图标统一'));
        window.set_default_size(960, 760);
        window.set_size_request(380, 420);
        const controlPath = GLib.build_filenamev([GLib.get_home_dir(), ...CONTROL_PATH_PARTS]);
        buildPreferences(window, {controlPath, settings: this.getSettings()});
    }
}
