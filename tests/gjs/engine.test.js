// End-to-end engine test on a throwaway HOME.
// Run: gjs -m tests/gjs/engine.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Engine} from '../../extension/lib/engine/engine.js';
import {readBytes, shaHex} from '../../extension/lib/engine/transaction.js';
import {MARKER_FILE, themeIndex} from '../../extension/lib/engine/theme.js';
import {readDesktopSection} from '../../extension/lib/engine/desktop.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];

function makeHome() {
    const home = GLib.dir_make_tmp('icon-normalizer-engine-XXXXXX');
    const apps = GLib.build_filenamev([home, '.local', 'share', 'applications']);
    GLib.mkdir_with_parents(apps, 0o755);
    return {home, apps};
}

function writeFixtureIcon(path) {
    // A 128 px opaque square with a translucent border ring.
    const size = 128;
    const buf = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const edge = x < 4 || y < 4 || x > size - 5 || y > size - 5;
            buf[i] = 60; buf[i + 1] = 60; buf[i + 2] = 60;
            buf[i + 3] = edge ? 30 : 255;
        }
    }
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, size, size, size * 4);
    pixbuf.savev(path, 'png', [], []);
}

function writeDesktop(path, icon) {
    const text = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Fixture App',
        'Exec=sh',
        'Icon=' + icon,
        '',
    ].join('\n');
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text), null,
        false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function removeTree(path) {
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null)) return;
    const children = dir.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null)) !== null) {
        const child = dir.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY) removeTree(child.get_path());
        else child.delete(null);
    }
    dir.delete(null);
}

function buildEngine(home, apps, iconPath) {
    const themeDir = GLib.build_filenamev([home, '.local', 'share', 'icons', 'DockNormalized']);
    const stateDir = GLib.build_filenamev([home, '.local', 'state', 'icon-normalizer']);
    GLib.mkdir_with_parents(stateDir, 0o755);
    return new Engine({
        home,
        themeDir,
        themeName: 'DockNormalized',
        stateDir,
        userApplications: apps,
        desktop: 'GNOME',
        policy: {base_theme: 'hicolor', target: 0.83, deadband: 0.02, inner: 0.7, sizes: SIZES},
        overrides: {},
        userRules: {},
        applicationDirs: [apps],
        settings: null,
    });
}

test('a full run generates the theme, rewrites the launcher and is idempotent', () => {
    const {home, apps} = makeHome();
    try {
        const iconPath = GLib.build_filenamev([home, 'fixture.png']);
        writeFixtureIcon(iconPath);
        const desktopPath = GLib.build_filenamev([apps, 'fixture.desktop']);
        writeDesktop(desktopPath, iconPath);

        const engine = buildEngine(home, apps, iconPath);
        const first = engine.sync({apply: true});

        assertEqual(first.applied, true, 'applied');
        assertTrue(first.file_operations > 0, 'wrote files');

        const themeDir = engine.themeDir;
        assertTrue(readBytes(GLib.build_filenamev([themeDir, MARKER_FILE])) !== null,
            'ownership marker written');
        const index = readBytes(GLib.build_filenamev([themeDir, 'index.theme']));
        assertEqual(new TextDecoder().decode(index),
            themeIndex('DockNormalized', 'hicolor', SIZES), 'index.theme content');

        const manifest = engine.manifest();
        const item = manifest.items[iconPath];
        assertTrue(Boolean(item), 'icon recorded in the manifest');
        assertEqual(Object.keys(item.files).length, SIZES.length + 1,
            'nine sizes plus the versioned 256 copy');

        // The launcher now points at the generated absolute icon path.
        const entry = readDesktopSection(readBytes(desktopPath));
        assertTrue(String(entry.Icon).startsWith(themeDir), 'launcher rewritten');
        assertEqual(entry.Name, 'Fixture App', 'other keys untouched');

        // A second run must not rewrite anything.
        const second = engine.sync({apply: true});
        assertEqual(second.file_operations, 0, 'second run is a no-op');
    } finally {
        removeTree(home);
    }
});

test('revert restores the launcher and removes managed artwork', () => {
    const {home, apps} = makeHome();
    try {
        const iconPath = GLib.build_filenamev([home, 'fixture.png']);
        writeFixtureIcon(iconPath);
        const desktopPath = GLib.build_filenamev([apps, 'fixture.desktop']);
        writeDesktop(desktopPath, iconPath);
        const originalBytes = readBytes(desktopPath);

        const engine = buildEngine(home, apps, iconPath);
        engine.sync({apply: true});
        const result = engine.revert();

        assertEqual(result.reverted, true, 'reverted');
        assertEqual(shaHex(readBytes(desktopPath)), shaHex(originalBytes),
            'launcher restored byte for byte');
        const manifest = engine.manifest();
        assertEqual(Object.keys(manifest.items).length, 0, 'manifest cleared');
    } finally {
        removeTree(home);
    }
});

test('a skipped icon is not generated and its launcher stays untouched', () => {
    const {home, apps} = makeHome();
    try {
        const iconPath = GLib.build_filenamev([home, 'fixture.png']);
        writeFixtureIcon(iconPath);
        const desktopPath = GLib.build_filenamev([apps, 'fixture.desktop']);
        writeDesktop(desktopPath, iconPath);
        const originalBytes = readBytes(desktopPath);

        const engine = buildEngine(home, apps, iconPath);
        engine.config.userRules = {[iconPath]: {skip: true}};
        const payload = engine.sync({apply: true});

        const row = payload.apps.find(entry => entry.icon_name === iconPath);
        assertEqual(row.action, 'skipped', 'action');
        assertEqual(shaHex(readBytes(desktopPath)), shaHex(originalBytes),
            'launcher untouched');
    } finally {
        removeTree(home);
    }
});

test('an icon already inside the dead band is kept', () => {
    const {home, apps} = makeHome();
    try {
        const iconPath = GLib.build_filenamev([home, 'fixture.png']);
        writeFixtureIcon(iconPath);
        const desktopPath = GLib.build_filenamev([apps, 'fixture.desktop']);
        writeDesktop(desktopPath, iconPath);

        const engine = buildEngine(home, apps, iconPath);
        // The fixture fills its canvas, so 0.83 target is outside the dead band.
        const payload = engine.sync({apply: false});
        const row = payload.apps.find(entry => entry.icon_name === iconPath);
        assertEqual(row.action, 'shrink', 'a full-canvas icon shrinks');
        assertEqual(payload.applied, undefined, 'dry run reports no write');
    } finally {
        removeTree(home);
    }
});

await report();
