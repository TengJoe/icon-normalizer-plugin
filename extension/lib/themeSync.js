// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';

const YARU_ACCENTS = {
    blue: 'blue',
    teal: 'prussiangreen',
    green: 'olive',
    yellow: 'yellow',
    orange: '',
    red: 'red',
    pink: 'magenta',
    purple: 'purple',
    slate: 'sage',
    brown: 'wartybrown',
};

export function targetGtkTheme(scheme, accent) {
    if (!Object.hasOwn(YARU_ACCENTS, accent)) return null;
    const variant = YARU_ACCENTS[accent];
    return `Yaru${variant ? `-${variant}` : ''}${scheme === 'prefer-dark' ? '-dark' : ''}`;
}

export function isThemeInstalled(theme) {
    const roots = [
        GLib.build_filenamev([GLib.get_home_dir(), '.themes']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'themes']),
        ...GLib.get_system_data_dirs().map(path => GLib.build_filenamev([path, 'themes'])),
    ];
    for (const root of roots) {
        const path = GLib.build_filenamev([root, theme, 'gtk-3.0', 'gtk.css']);
        if (GLib.file_test(path, GLib.FileTest.IS_REGULAR))
            return true;
    }
    return false;
}

export function syncGtkTheme(settings, installed = isThemeInstalled) {
    if (!settings) return;
    let scheme = settings.get_string('color-scheme');
    let accent = '';
    try {
        accent = settings.get_string('accent-color');
    } catch {
        accent = 'blue';
    }

    // Promote Ubuntu 'default' to 'prefer-light' so xdg-desktop-portal broadcasts light mode (2)
    if (scheme === 'default') {
        settings.set_string('color-scheme', 'prefer-light');
        scheme = 'prefer-light';
    }

    const current = settings.get_string('gtk-theme');
    // Preserve manually chosen GTK families (including custom Yaru derivatives).
    const yaruNames = new Set(Object.values(YARU_ACCENTS).map(value =>
        `Yaru${value ? `-${value}` : ''}`));
    if (!yaruNames.has(current.replace(/-dark$/, ''))) return;
    const target = targetGtkTheme(scheme, accent);
    if (target && current !== target && installed(target))
        settings.set_string('gtk-theme', target);
}
