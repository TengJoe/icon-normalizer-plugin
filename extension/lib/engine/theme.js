// Generated overlay theme management: index, ownership marker, icon cache.
// Port of backend/icon_normalizer/theme.py. The overlay theme is a plain
// fixed-size directory tree owned by this tool; the ownership marker refuses
// to touch a directory the tool did not create.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const MARKER = 'icon-normalizer-owned-v1\n';
export const MARKER_FILE = '.icon-normalizer-owned';
export const MANIFEST_VERSION = 1;

/**
 * index.theme content: fixed-size Directories inheriting the source theme.
 *
 * @param {string} themeName overlay theme name
 * @param {string} baseTheme source theme it inherits
 * @param {number[]} sizes ladder of icon sizes
 * @returns {string} file content
 */
export function themeIndex(themeName, baseTheme, sizes) {
    const dirs = sizes.map(n => n + 'x' + n + '/apps');
    let text = "[Icon Theme]\n"
        + "Name=" + themeName + "\n"
        + "Comment=Normalized application artwork; original theme fallback\n"
        + "Inherits=" + baseTheme + ",hicolor\n"
        + "Directories=" + dirs.join(",") + "\n";
    sizes.forEach((n, i) => {
        text += "\n[" + dirs[i] + "]\nSize=" + n + "\nType=Fixed\nContext=Applications\n";
    });
    return text;
}

/**
 * Locate gtk-update-icon-cache via PATH, never a hardcoded path.
 *
 * @returns {string|null} absolute path or null
 */
export function cacheBinary() {
    const found = GLib.find_program_in_path('gtk-update-icon-cache');
    if (found) return found;
    return Gio.File.new_for_path('/usr/bin/gtk-update-icon-cache').query_exists(null)
        ? '/usr/bin/gtk-update-icon-cache' : null;
}

/**
 * Run a command to completion and return its exit status and stderr.
 *
 * @param {string[]} argv command line
 * @returns {{status: number, stderr: string}}
 */
function runSync(argv) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_PIPE});
    const proc = launcher.spawnv(argv);
    const [, stderr] = proc.communicate_utf8(null, null);
    return {status: proc.get_exit_status(), stderr: stderr || ""};
}

export class ThemeDirectory {
    /**
     * @param {string} dir theme directory path
     * @param {string} name theme name
     */
    constructor(dir, name) {
        this.dir = dir;
        this.name = name;
    }

    /**
     * False when absent; throw when present but not owned by this tool.
     *
     * @returns {boolean} true when the directory exists and is ours
     */
    owned() {
        const dirFile = Gio.File.new_for_path(this.dir);
        if (!dirFile.query_exists(null)) return false;
        const marker = Gio.File.new_for_path(GLib.build_filenamev([this.dir, MARKER_FILE]));
        if (!marker.query_exists(null))
            throw new Error("Generated theme exists but is not owned by this tool");
        const [, bytes] = marker.load_contents(null);
        const text = new TextDecoder().decode(bytes);
        if (text !== MARKER)
            throw new Error("Generated theme exists but is not owned by this tool");
        return true;
    }

    /**
     * @returns {string[]} every generated PNG, sorted
     */
    pngs() {
        const out = [];
        const dir = Gio.File.new_for_path(this.dir);
        if (!dir.query_exists(null)) return out;
        const sizes = dir.enumerate_children("standard::name,standard::type",
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = sizes.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            if (!/^\d+x\d+$/.test(info.get_name())) continue;
            const apps = dir.get_child(info.get_name()).get_child("apps");
            if (!apps.query_exists(null)) continue;
            const files = apps.enumerate_children("standard::name",
                Gio.FileQueryInfoFlags.NONE, null);
            let entry;
            while ((entry = files.next_file(null)) !== null) {
                const name = entry.get_name();
                if (name.endsWith('.png'))
                    out.push(GLib.build_filenamev([this.dir, info.get_name(), "apps", name]));
            }
        }
        return out.sort();
    }

    /**
     * @returns {boolean} true when at least one generated PNG exists
     */
    hasPngs() {
        return this.pngs().length > 0;
    }

    /**
     * @returns {boolean} true when icon-theme.cache matches the tree
     */
    cacheValid() {
        const index = Gio.File.new_for_path(GLib.build_filenamev([this.dir, "index.theme"]));
        if (!index.query_exists(null)) return false;
        if (!this.hasPngs())
            return !Gio.File.new_for_path(GLib.build_filenamev([this.dir, "icon-theme.cache"]))
                .query_exists(null);
        const binary = cacheBinary();
        if (!binary) return false;
        return runSync([binary, "--validate", this.dir]).status === 0;
    }

    /** Rebuild or remove the icon cache, matching theme.py. */
    rebuild() {
        const cache = GLib.build_filenamev([this.dir, "icon-theme.cache"]);
        if (!this.hasPngs()) {
            const file = Gio.File.new_for_path(cache);
            if (file.query_exists(null)) file.delete(null);
            return;
        }
        const binary = cacheBinary();
        if (!binary) throw new Error("gtk-update-icon-cache not found on PATH");
        const result = runSync([binary, "--force", "--quiet", this.dir]);
        if (result.status !== 0 || !this.cacheValid())
            throw new Error("Icon cache rebuild failed: " + result.stderr.trim());
    }
}
