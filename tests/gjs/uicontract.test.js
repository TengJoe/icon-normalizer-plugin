// UI payload contract: every operation the interface invokes, tested with the
// exact argument shape the interface constructs. The 1.3.0 review found that
// tests written from the implementation ("policy:") missed that the UI sends
// "patch:" — so this file mirrors the call sites instead. Q20 greps the UI for
// invoked operations and fails when one of them has no case here.
// Run: gjs -m tests/gjs/uicontract.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {LocalControl} from '../../extension/lib/control.js';
import {readBytes, shaHex} from '../../extension/lib/engine/transaction.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

function makeFixtureHome() {
    const home = GLib.dir_make_tmp('icon-normalizer-uicontract-XXXXXX');
    const apps = GLib.build_filenamev([home, '.local', 'share', 'applications']);
    GLib.mkdir_with_parents(apps, 0o755);
    const buf = new Uint8Array(64 * 64 * 4).fill(255);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, 64, 64, 64 * 4);
    const iconPath = GLib.build_filenamev([home, 'fixture.png']);
    pixbuf.savev(iconPath, 'png', [], []);
    Gio.File.new_for_path(GLib.build_filenamev([apps, 'fixture.desktop'])).replace_contents(
        new TextEncoder().encode(
            '[Desktop Entry]\nType=Application\nName=Fixture App\nExec=sh\nIcon=' + iconPath + '\n'),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return {home, iconPath};
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

/** Assert a rejection carries the given protocol error code. */
async function assertCode(promise, code, what) {
    let caught = null;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    assertTrue(caught !== null, what + ': rejected');
    assertEqual(caught.code, code, what);
}

test('status {} — panel refresh (indicator.js)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const status = await control.handle('status', {});
        assertEqual(status.installed, true, 'installed');
        assertTrue(typeof status.revision === 'string', 'revision');
    } finally {
        removeTree(home);
    }
});

test('scan {} — rules page load (rulesPage.js)', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const scan = await control.handle('scan', {});
        assertTrue(Array.isArray(scan.groups), 'groups');
        assertTrue(scan.groups.some(g => g.icon_name === iconPath), 'fixture found');
    } finally {
        removeTree(home);
    }
});

test('apply {expected_revision, activate} — panel and maintenance flows '
    + '(applyFlow.js, maintenancePage.js)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const status = await control.handle('status', {});
        const apply = await control.handle('apply',
            {expected_revision: status.revision, activate: true});
        assertEqual(apply.applied, true, 'applied');
        assertEqual(apply.theme_activation, 'unavailable', 'no setTheme shim in test');
        await assertCode(control.handle('apply',
            {expected_revision: '0'.repeat(64), activate: false}), 'REVISION_CONFLICT',
            'stale revision');
    } finally {
        removeTree(home);
    }
});

test('preview {icon_id, source_sha256, size} — preview dialog '
    + '(previewDialog.js sends the scanned group verbatim)', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const scan = await control.handle('scan', {});
        const group = scan.groups.find(g => g.icon_name === iconPath);
        assertTrue(Boolean(group), 'group present');
        const preview = await control.handle('preview', {
            icon_id: group.icon_id,
            source_sha256: group.source_sha256,
            size: 48,
        });
        assertTrue(typeof preview.original_png_base64 === 'string', 'original');
        assertTrue(typeof preview.proposed_png_base64 === 'string', 'proposed');
        assertEqual(preview.icon_id, group.icon_id, 'identity echo');
        // A stale fingerprint must be refused, never rendered.
        await assertCode(control.handle('preview', {
            icon_id: group.icon_id,
            source_sha256: 'f'.repeat(64),
            size: 48,
        }), 'STALE_SOURCE', 'stale source');
    } finally {
        removeTree(home);
    }
});

test('rules.set {expected_revision, icon_id, rule} — rules page '
    + '(rulesPage.js classification/skip payloads)', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const status = await control.handle('status', {});
        const digest = shaHex(readBytes(iconPath));
        const set = await control.handle('rules.set', {
            expected_revision: status.revision,
            icon_id: shaHex(iconPath),
            rule: {skip: false, classification: 'glyph', source_sha256: digest},
        });
        assertEqual(set.rule.classification, 'glyph', 'rule stored');
        const rules = control.userRules();
        assertEqual(rules[shaHex(iconPath)].classification, 'glyph', 'persisted');
    } finally {
        removeTree(home);
    }
});

test('configure {expected_revision, patch} — rules page save button '
    + '(rulesPage.js sends patch:, never policy:)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const status = await control.handle('status', {});
        const configured = await control.handle('configure', {
            expected_revision: status.revision,
            patch: {target: 0.92, deadband: 0.02, inner: 0.7},
        });
        assertEqual(configured.effective_policy.target, 0.92, 'patch applied');
        assertEqual(control.policy().target, 0.92, 'persisted to config.json');
        // Out of range and cross-field violations, as the UI can produce them.
        await assertCode(control.handle('configure', {patch: {target: 1.2}}),
            'INVALID_CONFIG', 'range violation');
        await assertCode(control.handle('configure',
            {patch: {target: 0.99, deadband: 0.05}}), 'INVALID_CONFIG', 'cross-field');
        await assertCode(control.handle('configure', {patch: {inner: 1.5}}),
            'INVALID_CONFIG', 'inner violation');
    } finally {
        removeTree(home);
    }
});

test('profiles.list/save/delete — named profiles page (namedProfiles.js)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        let catalog = await control.handle('profiles.list', {});
        assertEqual(catalog.profiles.length, 0, 'empty catalogue');
        const saved = await control.handle('profiles.save', {
            name: '工作',
            parameters: {target: 0.9, deadband: 0.02, inner: 0.7},
        });
        assertTrue(Boolean(saved.profile && saved.profile.id), 'profile id');
        catalog = await control.handle('profiles.list', {});
        assertEqual(catalog.profiles.length, 1, 'saved');
        assertEqual(catalog.profiles[0].parameters.target, 0.9, 'parameters');
        await assertCode(control.handle('profiles.save',
            {name: '工作', parameters: {target: 0.9, deadband: 0.02, inner: 0.7}}),
            'INVALID_CONFIG', 'duplicate name');
        await control.handle('profiles.delete', {profile_id: saved.profile.id});
        catalog = await control.handle('profiles.list', {});
        assertEqual(catalog.profiles.length, 0, 'deleted');
    } finally {
        removeTree(home);
    }
});

test('theme.follow {enabled} / automation.set {enabled} / theme.sync {} '
    + '— maintenance page switches (maintenancePage.js)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const follow = await control.handle('theme.follow', {enabled: false});
        assertEqual(follow.ok, true, 'follow ok');
        assertEqual(follow.theme_follow, false, 'follow echoed');
        const automation = await control.handle('automation.set', {enabled: true});
        assertEqual(automation.ok, true, 'automation ok');
        assertEqual(automation.units.enabled, true, 'automation persisted');
        const sync = await control.handle('theme.sync', {});
        assertEqual(sync.ok, true, 'sync ok');
        assertEqual(sync.synced, false, 'follow disabled: nothing synced');
        const status = await control.handle('status', {});
        assertEqual(status.theme_follow, false, 'status reflects the switch');
        assertTrue(['on', 'unknown'].includes(status.units.automatic), 'units shape');
    } finally {
        removeTree(home);
    }
});

test('revert {} — maintenance page restore (maintenancePage.js)', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        await control.handle('apply', {activate: false});
        const revert = await control.handle('revert', {});
        assertEqual(revert.reverted, true, 'reverted');
    } finally {
        removeTree(home);
    }
});

await report();
