// Icon resolution against the SOURCE theme (never the overlay).
// Port of backend/icon_normalizer/core/resolver.py.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CONTEXTS = ['apps', 'mimetypes', 'status', 'categories', 'devices', 'actions', 'places'];
const SIZES = ['256x256', 'scalable', '512x512', '128x128', '96x96', '64x64', '48x48', '32x32', '24x24', '16x16'];
const EXTENSIONS = ['.png', '.svg', '.svgz'];
const STANDARD_DIRS = CONTEXTS.flatMap(context => SIZES.map(size => size + '/' + context));

function findIconInDir(themeDir, directories, name) {
    for (const dir of directories) {
        for (const ext of EXTENSIONS) {
            const p = GLib.build_filenamev([themeDir, dir, name + ext]);
            if (Gio.File.new_for_path(p).query_exists(null)) return p;
        }
    }
    return null;
}

/**
 * Pure JavaScript XDG theme icon resolver, matching freedesktop icon theme specs.
 * Does not depend on Gtk or St, so it runs identically in Shell, Prefs and plain GJS.
 */
/**
 * Icon theme search roots, in freedesktop precedence order.
 *
 * @param {string} home user home directory
 * @returns {string[]} directories that may contain <theme>/index.theme
 */
export function iconSearchRoots(home = GLib.get_home_dir()) {
    const dataHome = home === GLib.get_home_dir()
        ? GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']) : null;
    return [...new Set([
        GLib.build_filenamev([home, '.icons']),
        ...(dataHome ? [dataHome] : []),
        GLib.build_filenamev([home, '.local', 'share', 'icons']),
        ...GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, 'icons'])),
        '/usr/share/icons',
        '/usr/local/share/icons',
        '/var/lib/flatpak/exports/share/icons',
        GLib.build_filenamev([home, '.local', 'share', 'flatpak', 'exports', 'share', 'icons']),
    ])];
}

export function isSourceThemeName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 128
        && name !== 'DockNormalized' && name !== '.' && name !== '..'
        && /^[A-Za-z0-9._-]+$/.test(name);
}

function themeDirectories(baseTheme, searchRoots) {
    const seen = new Set();
    const entries = [];
    function addTheme(theme) {
        if (!isSourceThemeName(theme) || seen.has(theme)) return;
        seen.add(theme);
        const inherited = new Set();
        for (const root of searchRoots) {
            const themeDir = GLib.build_filenamev([root, theme]);
            if (!GLib.file_test(themeDir, GLib.FileTest.IS_DIR)) continue;
            const {inherits, directories} = parseThemeIndex(GLib.build_filenamev([themeDir, 'index.theme']));
            const declared = directories.filter(dir =>
                dir.split('/').every(part => part && part !== '.' && part !== '..'));
            entries.push([themeDir, [...new Set([...STANDARD_DIRS, ...declared])]]);
            for (const parent of inherits) inherited.add(parent);
        }
        for (const parent of inherited) addTheme(parent);
    }
    addTheme(baseTheme);
    addTheme('hicolor');
    return entries;
}

function findThemeIcon(name, searchRoots, entries) {
    for (const [themeDir, directories] of entries) {
        const hit = findIconInDir(themeDir, directories, name);
        if (hit) return hit;
    }
    for (const root of searchRoots) {
        for (const ext of EXTENSIONS) {
            const p = GLib.build_filenamev([root, name + ext]);
            if (Gio.File.new_for_path(p).query_exists(null)) return p;
        }
    }
    for (const ext of ['.png', '.svg', '.xpm']) {
        const p = '/usr/share/pixmaps/' + name + ext;
        if (Gio.File.new_for_path(p).query_exists(null)) return p;
    }
    return null;
}

export function resolveThemeIcon(name, baseTheme, home = GLib.get_home_dir()) {
    const roots = iconSearchRoots(home);
    return findThemeIcon(name, roots, themeDirectories(baseTheme, roots));
}

export class XdgIconResolver {
    constructor(baseTheme, home = GLib.get_home_dir()) {
        this.baseTheme = baseTheme;
        this.home = home;
        this._cache = new Map();
        this._roots = iconSearchRoots(home);
        this._entries = null;
    }

    lookup(name, size = 256) {
        if (this._cache.has(name)) return this._cache.get(name);
        this._entries ??= themeDirectories(this.baseTheme, this._roots);
        const hit = findThemeIcon(name, this._roots, this._entries);
        if (!hit) throw new Error("No icon for " + name);
        this._cache.set(name, hit);
        return hit;
    }
}

/**
 * Resolve an icon reference to a concrete source file.
 *
 * Absolute references pass through; theme names go through the resolver.
 * Anything inside the generated overlay is rejected as a source.
 */
export function resolveSource(icon, resolver, options = {}) {
    const size = options.size ?? 256;
    let path;
    if (icon.startsWith("/")) {
        path = icon;
    } else {
        if (!resolver) throw new Error("No resolver for theme icon " + icon);
        path = resolver.lookup(icon, size);
    }
    if (!Gio.File.new_for_path(path).query_exists(null))
        throw new Error("No icon file at " + path);
    if (options.forbiddenDir && isInside(path, options.forbiddenDir))
        throw new Error("Generated icon cannot be a source: " + path);
    return path;
}

/**
 * True when a path lives inside a directory.
 */
export function isInside(path, dir) {
    const normalise = value => {
        const resolved = Gio.File.new_for_path(value).resolve_relative_path("");
        return resolved.get_path();
    };
    const parent = normalise(dir);
    const child = normalise(path);
    return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

/**
 * Parse an icon theme index into its Inherits chain and directories.
 */
export function parseThemeIndex(indexPath) {
    const file = Gio.File.new_for_path(indexPath);
    if (!file.query_exists(null)) return {inherits: [], directories: []};
    const [, bytes] = file.load_contents(null);
    const text = new TextDecoder().decode(bytes);
    let inherits = [];
    const directories = [];
    let inMain = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith("[")) {
            inMain = line === "[Icon Theme]";
            continue;
        }
        if (!inMain) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === "Inherits") inherits = value.split(",").map(s => s.trim()).filter(Boolean);
        if (key === "Directories" || key === "ScaledDirectories")
            directories.push(...value.split(",").map(s => s.trim()).filter(Boolean));
    }
    return {inherits, directories};
}
