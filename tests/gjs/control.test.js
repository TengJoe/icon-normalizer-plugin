// Unit tests for the in-process LocalControl dispatcher.
// Run: gjs -m tests/gjs/control.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {LocalControl, DEFAULT_POLICY} from '../../extension/lib/control.js';
import {SyncLock, readBytes, atomicWrite} from '../../extension/lib/engine/transaction.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

const fixtureAppsDir = home => [GLib.build_filenamev([home, '.local', 'share', 'applications'])];

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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), locking: true});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), slicing: true});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
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

test('theme.sync adopts the newly selected source theme', async () => {
    const {home} = makeFixtureHome();
    try {
        // A source theme that is actually installed, so adoption can accept it.
        const themeDir = GLib.build_filenamev([home, ".local/share/icons/Adwaita"]);
        GLib.mkdir_with_parents(themeDir, 0o755);
        GLib.file_set_contents(GLib.build_filenamev([themeDir, "index.theme"]),
            "[Icon Theme]\nName=Adwaita\n");

        let active = "DockNormalized";
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), settings: {
            desktop: () => "GNOME",
            iconTheme: () => active,
            baseTheme: () => null,
            automatic: () => null,
            setTheme: name => { active = name; },
        }});
        // Following only makes sense once an overlay exists.
        await control.handle("apply", {activate: false});
        const before = control.policy().base_theme;

        active = "Adwaita";
        const synced = await control.handle("theme.sync", {});
        assertEqual(synced.adopted, "Adwaita", "adopted the selected theme");
        assertEqual(control.policy().base_theme, "Adwaita", "persisted as the new source");
        assertTrue(before !== "Adwaita", "source actually changed");

        // The overlay itself and unknown themes are never adopted.
        active = "DockNormalized";
        assertEqual((await control.handle("theme.sync", {})).adopted, null, "overlay ignored");
        active = "NotInstalledTheme";
        assertEqual((await control.handle("theme.sync", {})).adopted, null, "missing theme refused");
        assertEqual(control.policy().base_theme, "Adwaita", "source unchanged by refusals");

        // Turning following off stops the adoption entirely.
        await control.handle("theme.follow", {enabled: false});
        active = "Adwaita2";
        const off = await control.handle("theme.sync", {});
        assertEqual(off.synced, false, "not synced while disabled");
        assertEqual(control.policy().base_theme, "Adwaita", "source unchanged while disabled");
    } finally {
        removeTree(home);
    }
});

test('theme.sync follows the dark preference and accent colour', async () => {
    const {home} = makeFixtureHome();
    try {
        // Installed Yaru variants: the resolver may only choose from these.
        for (const name of ["Yaru", "Yaru-dark", "Yaru-blue", "Yaru-blue-dark", "Yaru-olive"]) {
            const dir = GLib.build_filenamev([home, ".local/share/icons", name]);
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(GLib.build_filenamev([dir, "index.theme"]),
                "[Icon Theme]\nName=" + name + "\n");
        }
        let active = "DockNormalized";
        let scheme = "default";
        let accent = "blue";
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), settings: {
            desktop: () => "GNOME",
            iconTheme: () => active,
            baseTheme: () => null,
            colorScheme: () => scheme,
            accent: () => accent,
            automatic: () => null,
            setTheme: name => { active = name; },
        }});
        await control.handle("apply", {activate: false});

        // A dark preference switches to the dark sibling of the accent colour.
        scheme = "prefer-dark";
        let synced = await control.handle("theme.sync", {});
        assertEqual(synced.adopted, "Yaru-blue-dark", "dark variant of the accent");
        assertEqual(control.policy().base_theme, "Yaru-blue-dark", "persisted dark source");

        // Back to light.
        scheme = "default";
        synced = await control.handle("theme.sync", {});
        assertEqual(synced.adopted, "Yaru-blue", "light variant");

        // Accent change moves within the Yaru family.
        accent = "green";
        synced = await control.handle("theme.sync", {});
        assertEqual(synced.adopted, "Yaru-olive", "green maps to olive");

        // An accent with no Yaru variant leaves the source alone (the real
        // machine may install more Yaru colours than this fixture creates, so
        // use a name the mapping table itself does not know).
        accent = "chartreuse";
        synced = await control.handle("theme.sync", {});
        assertEqual(synced.adopted, null, "unmapped accent refused");
        assertEqual(control.policy().base_theme, "Yaru-olive", "source unchanged");
    } finally {
        removeTree(home);
    }
});

test('theme.sync activates only a current selection and restore survives maintenance', async () => {
    const {home} = makeFixtureHome();
    try {
        for (const name of ['FixtureBlue', 'FixtureGreen']) {
            const dir = GLib.build_filenamev([home, '.local/share/icons', name]);
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(GLib.build_filenamev([dir, 'index.theme']),
                '[Icon Theme]\nName=' + name + '\n');
        }
        let active = 'FixtureBlue';
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), locking: true, settings: {
            desktop: () => 'GNOME',
            iconTheme: () => active,
            automatic: () => null,
            setTheme: name => { active = name; },
        }});
        await control.handle('automation.set', {enabled: true});
        const sync = name => control.handle('theme.sync', {activate_if_current_theme: name});
        assertEqual((await sync(active)).synced, false, 'before first apply');
        await control.handle('apply', {activate: true});

        const engine = control.engine.bind(control);
        const oldSource = control.policy().base_theme;
        active = 'FixtureGreen';
        control.engine = policy => {
            const instance = engine(policy);
            instance.sync = () => { throw new Error('fixture render failure'); };
            return instance;
        };
        await sync(active).then(
            () => { throw new Error('failed render unexpectedly succeeded'); },
            error => assertEqual(error.message, 'fixture render failure'));
        assertEqual(control.policy().base_theme, oldSource, 'failed render did not save new source');
        assertEqual(active, 'FixtureGreen', 'failed render did not activate overlay');

        active = 'FixtureBlue';
        control.engine = policy => {
            const instance = engine(policy);
            instance.syncAsync = async options => {
                const payload = instance.sync(options);
                active = 'FixtureGreen';
                return payload;
            };
            return instance;
        };
        control.slicing = true;
        assertEqual((await sync('FixtureBlue')).theme_activation, 'superseded', 'changed during apply');
        assertEqual(active, 'FixtureGreen', 'new theme survives earlier render');
        control.engine = engine;
        assertEqual((await sync('FixtureGreen')).theme_activation, 'applied', 'latest selection');
        assertEqual(active, 'DockNormalized', 'overlay is active');

        // A newer selection event also supersedes an older run if both names match.
        active = 'FixtureGreen';
        const stale = await control.handle('theme.sync', {
            activate_if_current_theme: active, canActivate: () => false,
        });
        assertEqual(stale.theme_activation, 'superseded', 'selection token changed');
        assertEqual(active, 'FixtureGreen', 'stale activation skipped');
        assertEqual((await sync(active)).theme_activation, 'applied', 'same source can reactivate');

        const restored = await control.handle('revert');
        assertEqual(restored.restored_theme, 'FixtureGreen', 'restored latest source');
        assertEqual((await sync(active)).synced, false, 'restore survives follow');
        assertEqual((await control.handle('apply', {background: true})).skipped, true,
            'restore survives periodic maintenance');
        assertEqual((await control.handle('apply', {activate: true})).theme_activation, 'applied',
            'explicit apply resumes after restore');

        await control.handle('automation.set', {enabled: false});
        active = 'FixtureBlue';
        assertEqual((await sync(active)).theme_activation, 'not_requested', 'automation disabled');
        await control.handle('automation.set', {enabled: true});
        await control.handle('theme.follow', {enabled: false});
        assertEqual((await sync(active)).theme_activation, 'not_requested', 'follow disabled');
        assertEqual(active, 'FixtureBlue', 'original theme remains active');
    } finally {
        removeTree(home);
    }
});

test('apply claims the theme for this engine', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
        const marker = GLib.build_filenamev([home, ".local/state/icon-normalizer", "renderer.json"]);
        assertTrue(!GLib.file_test(marker, GLib.FileTest.EXISTS), "no marker before apply");
        await control.handle("apply", {activate: false});
        const text = new TextDecoder().decode(readBytes(marker));
        assertEqual(JSON.parse(text).owner, "gjs", "owner recorded");
        // The Python guard reads exactly this value (renderer_owner.py).
        assertEqual(JSON.parse(text).schema_version, 1, "schema version");
    } finally {
        removeTree(home);
    }
});
test('raw-path user rule without sha256 appears in scan and resets by icon_id', async () => {
    const {home} = makeFixtureHome();
    try {
        const control = new LocalControl({home, applicationDirs: fixtureAppsDir(home), applicationDirs: fixtureAppsDir(home)});
        const first = (await control.handle('scan')).groups[0];
        const rulesPath = GLib.build_filenamev([control.stateDir, 'user-rules.json']);
        const doc = {schema_version: 1, icons: {[first.icon_name]: {classification: 'glyph'}}};
        atomicWrite(rulesPath, new TextEncoder().encode(JSON.stringify(doc, null, 2)), 0o600);
        const scanned = (await control.handle('scan')).groups[0];
        assertEqual(scanned.classification, 'glyph', 'legacy raw-path rule applied');
        assertEqual(scanned.classification_origin, 'user', 'origin surfaced as user');
        assertEqual(scanned.classification_stale, false, 'sha-less rule is not stale');
        const status = await control.handle('status');
        await control.handle('rules.set', {
            expected_revision: status.revision,
            icon_id: first.icon_id,
            rule: {reset: true},
        });
        const after = (await control.handle('scan')).groups[0];
        assertTrue(after.classification_origin !== 'user', 'reset clears legacy raw-path rule');
    } finally {
        removeTree(home);
    }
});

await report();
