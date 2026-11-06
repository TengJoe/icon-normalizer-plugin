// Icon resolution against the SOURCE theme (never the overlay).
// Port of backend/icon_normalizer/core/resolver.py.
//
// The theme implementation is injected: the preferences process passes a
// Gtk.IconTheme adapter, the Shell passes an St.IconTheme one. Both expose the
// same lookup(name, size) -> path contract, so this module stays host-agnostic
// and can also run under plain gjs.
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

/**
 * Resolve an icon reference to a concrete source file.
 *
 * Absolute references pass through; theme names go through the resolver.
 * Anything inside the generated overlay is rejected as a source.
 *
 * @param {string} icon icon name or absolute path
 * @param {{lookup: (name: string, size: number) => string}} [resolver]
 * @param {{size?: number, forbiddenDir?: string}} [options]
 * @returns {string} absolute path of the source artwork
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
 *
 * @param {string} path candidate file
 * @param {string} dir directory that must not contain it
 * @returns {boolean}
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
 *
 * Used by hosts that cannot rely on a toolkit theme object; the injected
 * adapters implement the same lookup contract on top of Gtk or St.
 *
 * @param {string} indexPath path to index.theme
 * @returns {{inherits: string[], directories: string[]}}
 */
export function parseThemeIndex(indexPath) {
    const file = Gio.File.new_for_path(indexPath);
    if (!file.query_exists(null)) return {inherits: [], directories: []};
    const [, bytes] = file.load_contents(null);
    const text = new TextDecoder().decode(bytes);
    let inherits = [];
    let directories = [];
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
        if (key === "Directories") directories = value.split(",").map(s => s.trim()).filter(Boolean);
    }
    return {inherits, directories};
}
