// Unit tests for the in-process LocalControl dispatcher.
// Run: gjs -m tests/gjs/control.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {LocalControl, DEFAULT_POLICY} from '../../extension/lib/control.js';
import {SyncLock, readBytes, atomicWrite} from '../../extension/lib/engine/transaction.js';
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

test('configure persists a partial patch', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const configured = await control.handle('configure', {patch: {target: 0.85}});
        assertEqual(configured.effective_policy.target, 0.85, 'target updated');
        const policy = control.policy();
        assertEqual(policy.target, 0.85, 'persisted target');
        // A patch that names only one key must leave the others alone.
        assertEqual(policy.inner, DEFAULT_POLICY.inner, 'inner untouched');
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

test('preview returns the protocol payload shape', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const preview = await control.handle('preview', {source_path: iconPath, size: 48});
        assertTrue(typeof preview.action === 'string' && preview.action.length > 0,
            'action present');
        assertTrue(typeof preview.original_png_base64 === 'string'
            && preview.original_png_base64.length > 0, 'original_png_base64');
        assertTrue(typeof preview.proposed_png_base64 === 'string'
            && preview.proposed_png_base64.length > 0, 'proposed_png_base64');
        assertTrue(typeof preview.metrics.source_ratio === 'number', 'metrics.source_ratio');
        assertEqual(preview.effective_policy.target, 0.83, 'effective policy target');
        assertTrue(typeof preview.saved_revision === 'string', 'saved_revision');
        assertEqual(preview.source_sha256.length, 64, 'source_sha256');
        assertEqual(preview.skipped, false, 'not skipped');
    } finally {
        removeTree(home);
    }
});

test('scan rejects while a recovery journal is pending', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        atomicWrite(GLib.build_filenamev([control.stateDir, 'pending.json']),
            new TextEncoder().encode(JSON.stringify({ops: []})), 0o600);
        let caught = null;
        try {
            await control.handle('scan');
        } catch (error) {
            caught = error;
        }
        assertTrue(caught !== null, 'scan refused');
        assertEqual(caught.code, 'RECOVERY_REQUIRED', 'protocol code');
    } finally {
        removeTree(home);
    }
});

test('apply rejects a stale expected_revision', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        let caught = null;
        try {
            await control.handle('apply', {expected_revision: '0'.repeat(64)});
        } catch (error) {
            caught = error;
        }
        assertTrue(caught !== null, 'apply refused');
        assertEqual(caught.code, 'REVISION_CONFLICT', 'protocol code');
        assertEqual(caught.details.current_revision, control.revision(), 'current revision');
        // A matching revision passes the gate.
        const apply = await control.handle('apply', {expected_revision: control.revision()});
        assertEqual(apply.applied, true, 'applied with fresh revision');
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

test('SyncLock serializes two controls on the same state dir', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home, locking: true});
        const holder = new SyncLock(control.lockPath());
        holder.acquire();
        let caught = null;
        try {
            await control.handle('status'); // unlocked op: always fine
            await control.handle('scan');
        } catch (error) {
            caught = error;
        }
        assertTrue(caught !== null, 'scan refused while locked');
        assertEqual(caught.code, 'BUSY', 'busy code');
        assertTrue(caught.retryable, 'busy is retryable');
        holder.release();
        const scan = await control.handle('scan');
        assertTrue(Array.isArray(scan.groups), 'scan proceeds after release');
    } finally {
        removeTree(home);
    }
});

test('sliced scan completes across idle callbacks', async () => {
    const {home, iconPath} = makeFixtureHome();
    try {
        const control = new LocalControl({home, slicing: true});
        const loop = GLib.MainLoop.new(null, false);
        const outcome = {payload: null, error: null};
        control.handle('scan').then(
            payload => { outcome.payload = payload; loop.quit(); },
            error => { outcome.error = error; loop.quit(); });
        loop.run();
        assertTrue(outcome.error === null, 'sliced scan ok: ' + outcome.error);
        const found = outcome.payload.groups.find(g => g.icon_name === iconPath);
        assertTrue(Boolean(found), 'fixture icon found in sliced scan');
    } finally {
        removeTree(home);
    }
});

await 
// The four protocol seams below are exercised with the exact payload shape the
// preferences UI sends. They used to be silent no-ops: configure ignored a
// patch, profiles.* were empty stubs and theme.follow/automation.set only
// echoed their arguments, so saving in the UI lost the change without saying so.

test('configure applies the patch shape the rules page sends', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const before = control.revision();
        const result = await control.handle('configure', {
            expected_revision: before,
            patch: {target: 0.92, deadband: 0.02, inner: 0.75},
        });
        assertEqual(result.effective_policy.target, 0.92, 'returned target');
        assertEqual(control.policy().target, 0.92, 'persisted target');
        assertEqual(control.policy().inner, 0.75, 'persisted inner');
        assertTrue(control.revision() !== before, 'revision moved');
        assertEqual(result.changed, true, 'changed flag');
        // Unpatched keys keep their previous value.
        assertEqual(result.effective_policy.deadband, 0.02, 'deadband preserved');
    } finally {
        removeTree(home);
    }
});

test('configure rejects an out-of-range or cross-field patch', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        for (const patch of [{target: 0.99}, {target: 0.95, deadband: 0.10},
            {target: 0.83, inner: 1.2}]) {
            let caught = null;
            try {
                await control.handle('configure', {patch});
            } catch (error) {
                caught = error;
            }
            assertTrue(caught !== null, 'rejected ' + JSON.stringify(patch));
            assertEqual(caught.code, 'INVALID_CONFIG', 'protocol code');
        }
    } finally {
        removeTree(home);
    }
});

test('profiles survive a save/list/delete round trip with OCC', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        const empty = await control.handle('profiles.list');
        assertEqual(empty.profiles.length, 0, 'starts empty');
        const saved = await control.handle('profiles.save', {
            expected_profiles_revision: empty.profiles_revision,
            name: 'compact',
            parameters: {target: 0.83, deadband: 0.02, inner: 0.70},
        });
        assertTrue(Boolean(saved.profile && saved.profile.id), 'profile id');
        const listed = await control.handle('profiles.list');
        assertEqual(listed.profiles.length, 1, 'persisted');
        assertEqual(listed.profiles[0].name, 'compact', 'name');
        assertTrue(listed.profiles_revision !== empty.profiles_revision, 'revision moved');
        // Stale revision is refused rather than silently merged.
        let caught = null;
        try {
            await control.handle('profiles.save', {
                expected_profiles_revision: empty.profiles_revision,
                name: 'other',
                parameters: {target: 0.83, deadband: 0.02, inner: 0.70},
            });
        } catch (error) {
            caught = error;
        }
        assertEqual(caught && caught.code, 'REVISION_CONFLICT', 'stale revision refused');
        const removed = await control.handle('profiles.delete', {profile_id: saved.profile.id});
        assertEqual(removed.profiles.length, 0, 'deleted');
    } finally {
        removeTree(home);
    }
});

test('theme.follow and automation.set persist and reach status', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home});
        await control.handle('theme.follow', {enabled: false});
        assertEqual((await control.handle('status')).theme_follow, false, 'follow off');
        await control.handle('theme.follow', {enabled: true});
        assertEqual((await control.handle('status')).theme_follow, true, 'follow on');

        await control.handle('automation.set', {enabled: true});
        const on = await control.handle('status');
        assertEqual(on.units.enabled, true, 'automation persisted');
        assertEqual(on.automatic, 'unknown', 'no heartbeat yet reads as unknown');
        control.recordHeartbeat(true);
        assertEqual((await control.handle('status')).automatic, 'on', 'heartbeat makes it on');
        control.recordHeartbeat(false, 'BUSY');
        assertEqual((await control.handle('status')).automatic_error, 'BUSY', 'failure surfaced');
        await control.handle('automation.set', {enabled: false});
        assertEqual((await control.handle('status')).automatic, 'off', 'off after disabling');
    } finally {
        removeTree(home);
    }
});
report();
