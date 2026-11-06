// Unit tests for the in-process LocalControl dispatcher.
// Run: gjs -m tests/gjs/control.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {LocalControl, DEFAULT_POLICY} from '../../extension/lib/control.js';
import {readBytes} from '../../extension/lib/engine/transaction.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

function makeFixtureHome() {
    const home = GLib.dir_make_tmp('icon-normalizer-control-test-XXXXXX');
    const apps = GLib.build_filenamev([home, '.local', 'share', 'applications']);
    GLib.mkdir_with_parents(apps, 0o755);
    const iconPath = GLib.build_filenamev([home, 'fixture.png']);
    const size = 64;
    const buf = new Uint8Array(size * size * 4);
    buf.fill(255);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, size, size, size * 4);
    pixbuf.savev(iconPath, 'png', [], []);
    const desktopPath = GLib.build_filenamev([apps, 'fixture.desktop']);
    const desktopText = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Fixture App',
        'Exec=sh',
        'Icon=' + iconPath,
        '',
    ].join('\n');
    Gio.File.new_for_path(desktopPath).replace_contents(new TextEncoder().encode(desktopText), null,
        false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return {home, apps, iconPath};
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

test('status reports installed true and valid revision', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const status = await control.handle('status');
        assertEqual(status.installed, true, 'installed');
        assertEqual(status.backend_version, 'gjs-1', 'version');
        assertTrue(typeof status.revision === 'string' && status.revision.length === 64, 'revision sha');
    } finally {
        removeTree(home);
    }
});

test('configure persists policy changes', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const configured = await control.handle('configure', {policy: {target: 0.85}});
        assertEqual(configured.effective_policy.target, 0.85, 'target updated');
        const policy = control.policy();
        assertEqual(policy.target, 0.85, 'persisted target');
    } finally {
        removeTree(home);
    }
});

test('rules.set stores and resets icon rules', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const setRes = await control.handle('rules.set', {
            icon_id: iconPath,
            rule: {classification: 'glyph'},
        });
        assertEqual(setRes.rule.classification, 'glyph', 'rule set');
        assertEqual(control.userRules()[iconPath].classification, 'glyph', 'rule in store');

        const resetRes = await control.handle('rules.set', {
            icon_id: iconPath,
            rule: {reset: true},
        });
        assertEqual(resetRes.rule, null, 'rule reset');
        assertTrue(control.userRules()[iconPath] === undefined, 'rule deleted from store');
    } finally {
        removeTree(home);
    }
});

test('preview renders a candidate base64 png', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const preview = await control.handle('preview', {source_path: iconPath, size: 48});
        assertTrue(typeof preview.candidate === 'string' && preview.candidate.length > 0, 'candidate base64');
        assertTrue(typeof preview.saved_revision === 'string', 'saved_revision');
    } finally {
        removeTree(home);
    }
});

test('scan, apply and revert cycle through LocalControl', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const scan = await control.handle('scan');
        assertTrue(Array.isArray(scan.groups), 'scan groups');
        const found = scan.groups.find(g => g.icon_name === iconPath);
        assertTrue(Boolean(found), 'fixture icon found in scan');

        const apply = await control.handle('apply');
        assertEqual(apply.applied, true, 'applied');
        assertTrue(apply.file_operations > 0, 'file operations > 0');

        const revert = await control.handle('revert');
        assertEqual(revert.reverted, true, 'reverted');
    } finally {
        removeTree(home);
    }
});

report();
