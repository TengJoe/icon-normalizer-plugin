import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

Adw.init();
globalThis.logError = (error, message) => printerr(`${message}: ${error.stack ?? error}`);
const root = ARGV[0];
const {buildPreferences} = await import(Gio.File.new_for_path(root + '/prefs/preferences.js').get_uri());
const {openPreview} = await import(Gio.File.new_for_path(root + '/prefs/previewDialog.js').get_uri());
const {call} = await import(Gio.File.new_for_path(root + '/shared/backendClient.js').get_uri());
const home = GLib.get_home_dir();
const controlPath = home + '/.local/libexec/icon-normalizer/control.py';
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(root + '/schemas', Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: schemaSource.lookup('org.gnome.shell.extensions.icon-normalizer', false)});
const wait = ms => new Promise(resolve => GLib.timeout_add(0, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
const check = (value, message) => {if (!value) throw new Error(message);};
const file = name => Gio.File.new_for_path(home + '/' + name);
const read = name => new TextDecoder().decode(file(name).load_contents(null)[1]);
const write = (name, text) => file(name).replace_contents(text, null, false, Gio.FileCreateFlags.PRIVATE, null);
async function until(predicate, message) {
    for (let attempt = 0; attempt < 150; attempt++) {
        if (predicate()) return;
        await wait(20);
    }
    throw new Error(message);
}
function remove(name) {if (file(name).query_exists(null)) file(name).delete(null);}
function widgets(root) {
    const found = [root];
    for (let child = root.get_first_child(); child; child = child.get_next_sibling()) found.push(...widgets(child));
    return found;
}
const loop = GLib.MainLoop.new(null, false);
let exitCode = 1;
const window = new Adw.PreferencesWindow();
const pages = buildPreferences(window, {controlPath, settings});
async function run() {
    window.present();
    await pages.ready;
    const group = pages.apps._groups[0];
    check(group, 'Fixture icon missing');
    write('delay-operation', 'preview');
    const preview = openPreview(window, group, {controlPath, settings});
    await until(() => file('started-preview').query_exists(null), 'Preview did not start');
    preview.close();
    const cancelled = await preview.ready;
    check(!cancelled.ok && cancelled.error.code === 'TIMEOUT', 'Closed preview read was not cancelled');
    await wait(600);
    check(!file('finished-preview').query_exists(null), 'Cancelled preview process continued');

    remove('started-preview');
    const rapid = openPreview(window, group, {controlPath, settings});
    await until(() => file('started-preview').query_exists(null), 'First preview did not start');
    const size = widgets(rapid.widget).find(widget => widget instanceof Gtk.ToggleButton && widget.label === '64px');
    check(size, 'Size toggle missing');
    const firstId = JSON.parse(read('started-preview')).request_id;
    size.set_active(true);
    check(!(await rapid.ready).ok, 'Superseded preview was not cancelled');
    await until(() => JSON.parse(read('started-preview')).request_id !== firstId, 'Replacement preview did not start');
    write('release-' + JSON.parse(read('started-preview')).request_id, '1');
    await until(() => file('finished-preview').query_exists(null), 'Latest preview did not complete');
    await until(() => widgets(rapid.widget).filter(widget => widget instanceof Gtk.Picture).length === 2,
        'Latest preview did not populate both stages');
    check(JSON.parse(read('finished-preview')).arguments.size === 64, 'Older preview won the race');
    rapid.close();

    remove('started-preview');
    remove('finished-preview');
    const parent = new Adw.PreferencesWindow();
    parent.present();
    const child = openPreview(parent, group, {controlPath, settings});
    await until(() => file('started-preview').query_exists(null), 'Child preview did not start');
    parent.close();
    check(!(await child.ready).ok, 'Parent close did not cancel the preview');

    write('delay-operation', '');
    await pages.rules.refresh(null, {discard: true});
    pages.rules._targetSpin.set_value(84);
    const before = read('operations.log').split('\n').filter(Boolean).length;
    write('delay-operation', 'configure');
    const saving = pages.rules._save(true);
    await until(() => file('started-configure').query_exists(null), 'Configuration write did not start');
    window.close();
    await saving;
    write('release-' + JSON.parse(read('started-configure')).request_id, '1');
    await until(() => file('finished-configure').query_exists(null), 'Running writer was killed on close');
    const operations = read('operations.log').split('\n').filter(Boolean).slice(before).map(line => JSON.parse(line).operation);
    check(operations.includes('configure') && !operations.includes('apply'), 'Closed save started a later apply');
    check(pages.rules._scope.closed && pages.apps._scope.closed && pages.maint._scope.closed,
        'Parent close did not cancel all page scopes');
    write('delay-operation', '');
    const next = new Adw.PreferencesWindow();
    const fresh = buildPreferences(next, {controlPath, settings});
    next.present();
    await fresh.ready;
    check(fresh.rules._targetSpin.get_value() === 84, 'Writer did not finish or reopened window retained old state');
    next.close();
    print(JSON.stringify({ok: true, preview_close_cancelled: true, parent_close_cancelled: true, latest_preview_wins: true,
        writer_completed_after_close: true, no_followup_apply: true, reopen_reads_fresh_state: true}));
    exitCode = 0;
}
GLib.idle_add(0, () => {
    run().catch(error => printerr(error.stack)).finally(() => {window.close(); loop.quit();});
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();
System.exit(exitCode);
