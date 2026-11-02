// Real GTK preview + isolated backend: rule preservation and live redraw.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

Adw.init();
globalThis.logError = (error, message) => printerr(`${message}: ${error.stack ?? error}`);
const root = ARGV[0];
const legacy = ARGV[1] === 'legacy';
const {buildPreferences} = await import(Gio.File.new_for_path(root + '/prefs/preferences.js').get_uri());
const {openPreview} = await import(Gio.File.new_for_path(root + '/prefs/previewDialog.js').get_uri());
const {call} = await import(Gio.File.new_for_path(root + '/shared/backendClient.js').get_uri());
const source = Gio.SettingsSchemaSource.new_from_directory(root + '/schemas', Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.icon-normalizer', false)});
settings.set_string('ui-language', 'zh');
const control = GLib.get_home_dir() + '/.local/libexec/icon-normalizer/control.py';
const rulesPath = GLib.get_home_dir() + '/.local/state/icon-normalizer/user-rules.json';
const window = new Adw.PreferencesWindow({default_width: 960, default_height: 760});
const pages = buildPreferences(window, {controlPath: control, settings});
const check = (condition, message) => {if (!condition) throw new Error(message);};
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
function children(widget) {
    const result = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) result.push(...children(child));
    return result;
}
function rules() {
    return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(rulesPath)[1])).icons;
}
function images(dialog) {
    return children(dialog).filter(widget => widget instanceof Gtk.Picture).map(picture =>
        GLib.base64_encode(picture.get_paintable().save_to_png_bytes().get_data()));
}
async function clickAndWait(button, expectedLabel) {
    button.emit('clicked');
    for (let i = 0; i < 300; i++) {
        await delay(50);
        if (button.get_sensitive() && button.get_label() === expectedLabel) return;
    }
    throw new Error('Skip button did not settle with label ' + expectedLabel);
}
const loop = GLib.MainLoop.new(null, false);
let resultCode = 1;
let handle;
const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 45000, () => {
    printerr('Skip runtime check timed out'); loop.quit(); return GLib.SOURCE_REMOVE;
});
async function run() {
    window.present(); await pages.ready;
    let group = pages.apps._groups[0];
    const status = await call(control, 'status', {});
    const manual = {skip: false, classification: 'glyph', source_sha256: group.source_sha256};
    const set = await call(control, 'rules.set', {expected_revision: status.result.revision,
        icon_id: group.icon_id, rule: manual});
    check(set.ok, 'Manual rule setup failed');
    await pages.apps.refresh();
    group = pages.apps._groups[0];
    check(group.classification_origin === 'user', 'Manual rule is not active');
    for (const size of legacy ? [48] : [32, 48]) {
        settings.set_int('preview-size', size);
        handle = openPreview(window, group, {controlPath: control, settings, onRuleChanged: () => pages.apps.refresh()});
        const initial = await handle.ready;
        check(initial.ok && !initial.result.skipped, 'Initial preview failed');
        let widgets = children(handle.widget);
        let button = widgets.find(widget => widget instanceof Gtk.Button && widget.label === '跳过此图标');
        check(button, 'Skip button missing');
        if (legacy) {
            await clickAndWait(button, '跳过此图标');
            check(JSON.stringify(rules()[group.icon_id]) === JSON.stringify(manual), 'Old backend changed the rule');
            check(!group.skipped, 'Old backend was allowed to skip');
            handle.close(); handle = null;
            print(JSON.stringify({ok: true, legacy_backend_refused: true, rule_preserved: true}));
            resultCode = 0; return;
        }
        await clickAndWait(button, '取消跳过');
        check(rules()[group.icon_id].classification === 'glyph' &&
            rules()[group.icon_id].source_sha256 === manual.source_sha256 && rules()[group.icon_id].skip,
        'Skipping changed manual classification');
        widgets = children(handle.widget);
        const action = widgets.find(widget => widget instanceof Adw.ActionRow && widget.title === '处理动作');
        const pair = images(handle.widget);
        check(pair.length === 2 && pair[0] === pair[1], `Skipped preview did not refresh at ${size}px`);
        check(action.subtitle === '已按规则跳过', 'Skipped action did not refresh');
        button = widgets.find(widget => widget instanceof Gtk.Button && widget.label === '取消跳过');
        await clickAndWait(button, '跳过此图标');
        check(JSON.stringify(rules()[group.icon_id]) === JSON.stringify(manual), 'Unskip did not restore the manual rule');
        widgets = children(handle.widget);
        const restored = widgets.find(widget => widget instanceof Adw.ActionRow && widget.title === '处理动作');
        const restoredImages = images(handle.widget);
        check(restored.subtitle === '补充超椭圆底板', 'Unskip action did not refresh');
        check(restoredImages.length === 2 && restoredImages[0] !== restoredImages[1], 'Unskip preview did not refresh');
        handle.close(); handle = null;
        group = pages.apps._groups[0];
    }
    print(JSON.stringify({ok: true, sizes: [32, 48], skip_preview_refreshed: true,
        unskip_preview_refreshed: true, manual_rule_preserved: true}));
    resultCode = 0;
}
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    run().catch(error => printerr(error.stack ?? error)).finally(() => {
        GLib.source_remove(timeout); handle?.close(); window.close(); loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync(); System.exit(resultCode);
