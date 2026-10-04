import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import System from 'system';

Adw.init();
globalThis.logError = (error, message) => printerr(`${message}: ${error.stack ?? error}`);
const root = ARGV[0];
const output = ARGV[1];
const readonly = ARGV[2] === 'readonly';
const language = ARGV[3] ?? 'zh';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve(); return GLib.SOURCE_REMOVE;
}));
const controlPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'libexec', 'icon-normalizer', 'control.py']);
const source = Gio.SettingsSchemaSource.new_from_directory(root + '/schemas', Gio.SettingsSchemaSource.get_default(), false);
const nativeSettings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.icon-normalizer', false)});
if (!readonly) nativeSettings.set_string('ui-language', language);
// For live screenshots, override this UI-only read without changing the user's
// GSettings or the environment used by backend child processes.
const settings = readonly ? new Proxy(nativeSettings, {get(target, property) {
    if (property === 'get_string') return key => key === 'ui-language' ? language : target.get_string(key);
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
}}) : nativeSettings;
const {buildPreferences} = await import(Gio.File.new_for_path(root + '/ui/preferences.js').get_uri());
const {call} = await import(Gio.File.new_for_path(root + '/lib/backendClient.js').get_uri());
const window = new Adw.PreferencesWindow({title: '图标统一', default_width: 960, default_height: 760});
window.set_size_request(380, 420);
const pages = buildPreferences(window, {controlPath, settings});
const loop = GLib.MainLoop.new(null, false);
let code = 1;
// Wayland can throttle background windows to one frame per second, including
// fixture windows. Leave enough time for the complete matrix and screenshots.
// This does not change UI/CLI request timeouts.
const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000, () => {
    printerr('Responsive GTK validation timed out'); loop.quit(); return GLib.SOURCE_REMOVE;
});

async function capture(name) {
    if (!output) return;
    GLib.mkdir_with_parents(output, 0o700);
    const width = window.get_width(), height = window.get_height();
    // A page transition or resize can temporarily have no native render node,
    // particularly when Wayland throttles an unfocused validation window.
    let node = null;
    for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = new Gtk.Snapshot();
        Gtk.WidgetPaintable.new(window).snapshot(snapshot, width, height);
        node = snapshot.to_node();
        if (node) break;
        await delay(150);
    }
    check(node, 'No render node for ' + name);
    const bounds = new Graphene.Rect(); bounds.init(0, 0, width, height);
    const texture = window.get_renderer().render_texture(node, bounds);
    check(texture.save_to_png(output + '/' + name + '.png'), 'PNG export failed');
}

function overflow() {
    const bad = [];
    const visit = widget => {
        if (!widget.get_mapped()) return;
        const [valid, bounds] = widget.compute_bounds(window);
        const content = widget instanceof Gtk.Label || widget instanceof Gtk.Button
            || widget instanceof Gtk.Picture || widget instanceof Gtk.Entry;
        if (content && valid && (bounds.get_x() < -2 || bounds.get_x() + bounds.get_width() > window.get_width() + 2))
            bad.push(`${widget.constructor.name}: ${bounds.get_x()} + ${bounds.get_width()}`);
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) visit(child);
    };
    visit(window);
    return bad;
}

async function run() {
    const configPath = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'icon-normalizer', 'config.json']);
    const before = GLib.file_get_contents(configPath)[1];
    Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK);
    window.present();
    await pages.ready;
    await delay(300);
    const after = GLib.file_get_contents(configPath)[1];
    check(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(before)) ===
        GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(after)),
        'Opening preferences modified the saved policy');
    check(pages.rules._hasPolicy, 'Saved policy was not loaded');
    const policy = [pages.rules._targetSpin.get_value(), pages.rules._deadbandSpin.get_value(), pages.rules._innerSpin.get_value()];
    if (!readonly) check(JSON.stringify(policy) === '[83,2,70]', 'Unexpected fixture policy ' + policy);
    const dimensions = [];
    for (const [width, height] of [[1100,850], [960,720], [640,600], [420,560], [380,420], [960,480]]) {
        window.set_default_size(width, height);
        await delay(250);
        for (const [name, controller] of Object.entries({rules: pages.rules, apps: pages.apps, maintenance: pages.maint})) {
            window.set_visible_page(controller.page);
            await delay(200);
            const minimum = language === 'en' ? 420 : 380;
            check(window.get_width() <= Math.max(width, minimum) + 2,
                `${name} cannot shrink to ${Math.max(width, minimum)}: ${window.get_width()}`);
            const bad = overflow();
            check(bad.length === 0, `${name} ${width}: horizontal overflow: ` + bad.join('; '));
            if (name === 'maintenance') {
                check(pages.maint._badgeAuto.get_height() < 36, 'Status badge stretched vertically');
                if (width <= 480) {
                    const positions = pages.maint._actionLayout.children.map(button =>
                        button.compute_bounds(pages.maint._actionLayout.widget));
                    check(positions.every(([valid]) => valid), 'Action geometry unavailable');
                    check(positions.every(([, bounds], i) => i === 0 ||
                        Math.abs(bounds.get_x() - positions[0][1].get_x()) < 2 &&
                        bounds.get_y() > positions[i - 1][1].get_y()), 'Actions did not stack');
                }
            }
            await capture(`${name}-${width}x${height}-dark`);
            if (width === 420 && name !== 'apps') {
                let scroller;
                const find = widget => {
                    if (widget instanceof Gtk.ScrolledWindow) { scroller = widget; return; }
                    for (let child = widget.get_first_child(); child && !scroller; child = child.get_next_sibling()) find(child);
                };
                find(controller.page);
                const adjustment = scroller.get_vadjustment();
                adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size());
                await delay(200);
                check(overflow().length === 0, name + ' bottom actions overflow');
                await capture(`${name}-${width}x${height}-dark-bottom`);
                adjustment.set_value(0);
            }
            dimensions.push({page: name, width: window.get_width(), height: window.get_height(),
                horizontal_overflow: bad, list_height: name === 'apps' ? pages.apps._scrolled.get_height() : undefined,
                page_height: controller.page.get_height()});
        }
    }
    window.set_default_size(1100, 850);
    Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
    for (const [name, controller] of Object.entries({rules: pages.rules, apps: pages.apps, maintenance: pages.maint})) {
        window.set_visible_page(controller.page); await delay(200); await capture(`${name}-1100x850-light`);
    }

    const {openPreview} = await import(Gio.File.new_for_path(root + '/ui/previewDialog.js').get_uri());
    const group = pages.apps._groups.find(g => g.source_sha256 && g.action !== 'excluded');
    for (const [width, height] of [[960,720], [420,560]]) {
        window.set_default_size(width, height);
        window.set_visible_page(pages.apps.page);
        await delay(250);
        const preview = openPreview(window, group, {controlPath, settings});
        const result = await preview.ready;
        check(result.ok, 'Preview failed');
        await delay(300);
        check(overflow().length === 0, 'Preview controls overflow at ' + width);
        await capture(`preview-${width}x${height}-light`);
        preview.close();
        await delay(250);
    }

    if (!readonly) {
        // A radio filter cannot lose its selection, even when clicked twice.
        const chip = pages.apps._pills.buttons.get('all');
        pages.apps._pills.setSelection('all', false);
        chip.set_active(false);
        check(chip.active, 'Filter became unselected');
        // Preset save/reopen and external-revision conflict, in fixture only.
        pages.rules._presetButtons[2].emit('clicked');
        await pages.rules._save(false);
        check(pages.rules._loadedRevision, 'Save lost revision');
        pages.rules._dirty = false;
        await pages.rules.refresh(null, {discard: true});
        check(pages.rules._targetSpin.get_value() === 92, 'Reopening did not retain saved policy');
        const revision = pages.rules._loadedRevision;
        const external = await call(controlPath, 'configure', {expected_revision: revision,
            patch: {target: 0.83, inner: 0.70}});
        check(external.ok, 'External fixture update failed');
        await pages.rules._save(false);
        check(pages.rules._notice.row.get_visible(), 'Conflict was not surfaced');
        check(pages.rules._notice.row.get_title().includes(language === 'en' ? 'Reload' : '重新读取'), 'Conflict prompt is missing');
    }
    print(JSON.stringify({ok: true, language, saved_policy_controls: policy, dimensions,
        dark_light: true, preview_responsive: true, policy_readonly_on_open: true,
        fixture_save_conflict_checked: !readonly}));
    window.close();
    code = 0;
}
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    run().catch(error => printerr(`${error}\n${error.stack}`)).finally(() => {
        GLib.source_remove(deadline); loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();
System.exit(code);
