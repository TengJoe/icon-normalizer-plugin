// SPDX-License-Identifier: GPL-3.0-or-later
import {targetGtkTheme, isThemeInstalled, syncGtkTheme} from '../../extension/lib/themeSync.js';

function equal(actual, expected, message = '') {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const accents = {blue: 'blue', teal: 'prussiangreen', green: 'olive', yellow: 'yellow',
    orange: '', red: 'red', pink: 'magenta', purple: 'purple', slate: 'sage', brown: 'wartybrown'};
for (const [accent, variant] of Object.entries(accents)) {
    for (const dark of [false, true])
        equal(targetGtkTheme(dark ? 'prefer-dark' : 'prefer-light', accent),
            `Yaru${variant ? `-${variant}` : ''}${dark ? '-dark' : ''}`);
}
equal(targetGtkTheme('prefer-light', '../unknown'), null);
equal(targetGtkTheme('prefer-dark', 'toString'), null);
equal(isThemeInstalled('NonExistentThemeXYZ123'), false);
function settings(theme, scheme = 'default', accent = 'blue') {
    return {
        data: {'gtk-theme': theme, 'color-scheme': scheme, 'accent-color': accent},
        writes: [],
        get_string(key) { return this.data[key]; },
        set_string(key, value) { this.writes.push(key); this.data[key] = value; return true; },
    };
}
const s = settings('Yaru-olive-dark');
syncGtkTheme(s, () => true);
equal(s.data['color-scheme'], 'prefer-light');
equal(s.data['gtk-theme'], 'Yaru-blue');
syncGtkTheme(s, () => true);
equal(s.writes.length, 2, 'idempotent sync writes nothing');
for (const [scheme, accent, theme] of [['prefer-dark', 'purple', 'Yaru-purple-dark'],
    ['default', 'blue', 'Yaru-blue'], ['prefer-dark', 'teal', 'Yaru-prussiangreen-dark']]) {
    s.data['color-scheme'] = scheme; s.data['accent-color'] = accent;
    syncGtkTheme(s, () => true);
    equal(s.data['gtk-theme'], theme);
}
for (const name of ['Adwaita', 'Orchis-dark', 'Yaru-custom', 'Yaru-custom-dark']) {
    const custom = settings(name);
    syncGtkTheme(custom, () => true);
    equal(custom.data['gtk-theme'], name, 'manual GTK family preserved');
    equal(custom.data['color-scheme'], 'prefer-light', 'explicit light preference still reaches portal');
}
const absent = settings('Yaru-blue', 'prefer-dark', 'purple');
syncGtkTheme(absent, () => false);
equal(absent.data['gtk-theme'], 'Yaru-blue', 'missing theme never selected');
absent.data['accent-color'] = 'unknown';
syncGtkTheme(absent, () => true);
equal(absent.data['gtk-theme'], 'Yaru-blue', 'unknown accent preserves theme');
console.log('ok   themeSync.test.mjs passed all assertions (gjs runtime)');
