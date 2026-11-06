// Desktop entry scanning and Icon= rewriting.
// Port of backend/icon_normalizer/desktop.py: XDG application roots in
// shadowing order, freedesktop visibility rules, and a byte-preserving Icon=
// rewrite that never touches actions, locales or formatting.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/** Flatpak system exports the desktop stack also reads. */
const FLATPAK_EXPORTS = [
    '/var/lib/flatpak/exports/share',
    '/var/lib/snapd/desktop',
];

/**
 * XDG application directories in shadowing order (first hit wins).
 *
 * @param {string} home user home directory
 * @param {{dataDirs?: string, extraDirs?: string[]}} options
 * @returns {string[]} applications directories
 */
export function applicationRoots(home, options = {}) {
    const dataHome = GLib.getenv("XDG_DATA_HOME") || GLib.build_filenamev([home, ".local", "share"]);
    const dirs = [dataHome];
    const dirSource = options.dataDirs !== undefined
        ? options.dataDirs : (GLib.getenv("XDG_DATA_DIRS") || "/usr/local/share:/usr/share");
    for (const part of dirSource.split(":")) if (part) dirs.push(part);
    dirs.push(GLib.build_filenamev([home, ".local", "share", "flatpak", "exports", "share"]));
    dirs.push(...FLATPAK_EXPORTS);
    if (options.extraDirs) dirs.push(...options.extraDirs);
    const unique = [];
    for (const dir of dirs) if (!unique.includes(dir)) unique.push(dir);
    return unique.map(dir => GLib.build_filenamev([dir, "applications"]));
}

/**
 * Minimal POSIX-ish word splitting, matching shlex.split for Exec lines.
 *
 * @param {string} text
 * @returns {string[]} words
 */
export function splitExec(text) {
    const words = [];
    let current = "";
    let quote = null;
    let has = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) { quote = null; continue; }
            if (ch === "\\" && quote === '"' && i + 1 < text.length) { current += text[++i]; continue; }
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
        if (ch === "\\" && i + 1 < text.length) { current += text[++i]; has = true; continue; }
        if (ch === " " || ch === "\t" || ch === "\n") {
            if (has || current) { words.push(current); current = ""; has = false; }
            continue;
        }
        current += ch;
        has = true;
    }
    if (quote) throw new Error("No closing quotation");
    if (has || current) words.push(current);
    return words;
}

/**
 * Classify a desktop entry for the current desktop; "visible" means shown.
 *
 * @param {Record<string, string>} entry key/value pairs of [Desktop Entry]
 * @param {string} desktop colon-separated desktop names
 * @returns {string} visibility status
 */
export function entryVisibility(entry, desktop) {
    if ((entry.Hidden || "false").toLowerCase() === "true") return "hidden";
    if ((entry.NoDisplay || "false").toLowerCase() === "true") return "no_display";
    const active = new Set(desktop.split(":"));
    const only = new Set((entry.OnlyShowIn || "").split(";").filter(Boolean));
    const deny = new Set((entry.NotShowIn || "").split(";").filter(Boolean));
    if (only.size && ![...active].some(name => only.has(name)))
        return "only_show_in_other_desktop";
    if ([...active].some(name => deny.has(name)))
        return "not_show_in_current_desktop";
    const tryExec = entry.TryExec;
    if (tryExec && !GLib.find_program_in_path(tryExec)) return "tryexec_missing";
    let argv;
    try {
        argv = splitExec(entry.Exec || "");
    } catch {
        return "invalid_exec";
    }
    if (argv.length && !GLib.find_program_in_path(argv[0])) return "exec_missing";
    if (!argv.length && (entry.DBusActivatable || "false").toLowerCase() !== "true")
        return "exec_missing";
    return "visible";
}

/**
 * Parse the main [Desktop Entry] section of a .desktop blob.
 *
 * @param {Uint8Array} bytes file content
 * @returns {Record<string, string>} key/value pairs
 */
export function readDesktopSection(bytes) {
    // GKeyFile rejects several constructs configparser accepts (bare keys,
    // odd escapes, duplicate entries), so parse leniently instead: the scanner
    // must see the same entries as the Python reference.
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const out = {};
    let inMain = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('[')) {
            inMain = line === '[Desktop Entry]';
            continue;
        }
        if (!inMain) continue;
        const split = line.search(/[=:]/);
        if (split < 0) continue;
        const key = line.slice(0, split).trim();
        const value = line.slice(split + 1).trim();
        if (key) out[key] = value;
    }
    return out;
}

/**
 * Replace the main Icon= only; retain actions, locales, Exec and formatting.
 *
 * @param {Uint8Array} bytes file content
 * @param {string} icon replacement icon name
 * @returns {string} rewritten content
 */
export function rewriteIconLine(bytes, icon) {
    if (icon.includes("\n") || icon.includes("\r"))
        throw new Error("Invalid icon field");
    const text = new TextDecoder().decode(bytes);
    const lines = text.split(/(?<=\n)/);
    let main = false;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (stripped.startsWith("[")) {
            main = stripped === "[Desktop Entry]";
            continue;
        }
        if (!main) continue;
        if (!/^Icon\s*=/.test(lines[i])) continue;
        const end = lines[i].endsWith("\r\n") ? "\r\n"
            : lines[i].endsWith("\n") ? "\n" : "";
        lines[i] = "Icon=" + icon + end;
        found = true;
    }
    if (!found) throw new Error("Main desktop section has no Icon=");
    return lines.join("");
}

/**
 * Every .desktop file under a root, sorted by path.
 *
 * @param {string} root directory
 * @returns {string[]} absolute paths
 */
function desktopFilesUnder(root) {
    const out = [];
    const walk = path => {
        const dir = Gio.File.new_for_path(path);
        if (!dir.query_exists(null)) return;
        let children;
        try {
            children = dir.enumerate_children("standard::name,standard::type",
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        let info;
        while ((info = children.next_file(null)) !== null) {
            const child = GLib.build_filenamev([path, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) walk(child);
            else if (info.get_name().endsWith(".desktop")) out.push(child);
        }
    };
    walk(root);
    return out.sort();
}

/**
 * Group visible desktop entries by their Icon value.
 *
 * A user entry -- including one carrying Hidden=true -- masks the same
 * system-wide entry id.
 *
 * @param {string} desktop colon-separated desktop names
 * @param {string} home user home directory
 * @param {{applicationDirs?: string[], dataDirs?: string, entryTransform?: Function}} options
 * @returns {{grouped: Record<string, object[]>, counts: Record<string, number>,
 *            errors: object[]}}
 */
export function collectDesktopEntries(desktop, home, options = {}) {
    const roots = options.applicationDirs
        ? options.applicationDirs : applicationRoots(home, options);
    const seen = new Set();
    const grouped = {};
    const counts = {};
    const errors = [];
    // Python's ScanCounters.as_dict() omits zero counters; match it so the
    // persisted shape is identical.
    const bump = key => { counts[key] = (counts[key] || 0) + 1; };
    for (const root of roots) {
        for (const path of desktopFilesUnder(root)) {
            const relative = path.slice(root.length + 1);
            const appId = relative.split("/").join("-");
            if (seen.has(appId)) { bump("shadowed_entries"); continue; }
            seen.add(appId);
            bump("effective_entries");
            let entry;
            try {
                const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
                entry = readDesktopSection(bytes);
            } catch (error) {
                errors.push({desktop_path: path, error: String(error && error.message || error)});
                continue;
            }
            if (options.entryTransform) {
                const transformed = options.entryTransform(path, entry);
                if (transformed === null) continue;
                entry = transformed;
            }
            if (entry.Type !== "Application") { bump("not_application"); continue; }
            const status = entryVisibility(entry, desktop);
            bump(status);
            if (status === "hidden" || status === "no_display") continue;
            const icon = (entry.Icon || "").trim();
            if (!icon) { bump("missing_icon_field"); continue; }
            (grouped[icon] = grouped[icon] || []).push({
                desktop_id: appId,
                desktop_path: path,
                name: entry.Name || appId,
                visibility: status,
            });
        }
    }
    return {grouped, counts, errors};
}