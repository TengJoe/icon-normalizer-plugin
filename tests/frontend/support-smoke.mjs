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
const {AboutSupport} = await import(Gio.File.new_for_path(root + '/ui/aboutSupport.js').get_uri());
const {setLanguage, t} = await import(Gio.File.new_for_path(root + '/lib/i18n.js').get_uri());
const {ensureCss, translateWidgetTree} = await import(Gio.File.new_for_path(root + '/lib/uiCommon.js').get_uri());
ensureCss(Gio.File.new_for_path(root + '/lib/uiCommon.js').get_uri(), '../preferences.css');
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE; }));
const check = (value, message) => { if (!value) throw new Error(message); };
const window = new Adw.PreferencesWindow({default_width: 420, default_height: 560});
const page = new Adw.PreferencesPage({title: t('维护')});
const about = new AboutSupport(window);
page.add(about.group);
window.add(page);
const loop = GLib.MainLoop.new(null, false);
let exitCode = 1;
const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () => {
    printerr('Support runtime check timed out'); loop.quit(); return GLib.SOURCE_REMOVE;
});

async function run() {
    const dimensions = [];
    window.present();
    check(about.methods.size === 2 && !about.methods.has('wise'), 'Unexpected payment methods');
    for (const language of ['zh', 'en']) {
        setLanguage(language);
        translateWidgetTree(window);
        about.retranslate();
        window.set_title(t('图标统一'));
        window.set_size_request(language === 'en' ? 420 : 380, 420);
        check(about.group.title === t('关于与支持'), 'Support heading not translated');
        for (const [width, height] of [[language === 'en' ? 420 : 380, 560], [960, 760]]) {
            window.set_default_size(width, height);
            await wait(120);
            await capture(window, `about-${language}-${width}x${height}`);
            for (const id of ['wechat', 'alipay']) {
                const dialog = about.open(id);
                await wait(400);
                check(dialog && dialog.picture.get_paintable(), 'Payment picture missing');
                check(dialog.widget.title === t(dialog.method.label), 'Payment dialog title not translated');
                check(dialog.picture.alternative_text === t(dialog.method.label), 'Payment accessibility label missing');
                const [ok, bounds] = dialog.picture.compute_bounds(dialog.widget);
                check(ok && bounds.origin.x >= 0 && bounds.origin.y >= 0, 'Picture starts outside dialog');
                check(bounds.origin.x + bounds.size.width <= dialog.widget.get_width() + 1,
                    'Payment image overflows the dialog horizontally');
                dimensions.push({language, method: id, window: [window.get_width(), window.get_height()],
                    dialog: [dialog.widget.get_width(), dialog.widget.get_height()],
                    picture: [dialog.picture.get_width(), dialog.picture.get_height()]});
                await capture(dialog.widget, `${id}-${language}-${width}x${height}`);
                setLanguage(language === 'zh' ? 'en' : 'zh');
                about.retranslate();
                check(dialog.widget.title === t(dialog.method.label), 'Open dialog language is stale');
                setLanguage(language);
                about.retranslate();
                dialog.close();
                await wait(160);
                check(about._dialog === null, 'Closed payment dialog retained');
            }
        }
    }
    check(about.open('missing') === null, 'Unknown payment method accepted');
    const last = about.open('wechat');
    await wait(100);
    window.close();
    await wait(160);
    check(about._dialog === null, 'Payment dialog retained after parent close');
    print(JSON.stringify({ok: true, payment_methods: ['wechat', 'alipay'],
        dimensions, open_dialog_language_switch: true, close_cleanup: true}));
    exitCode = 0;
}

async function capture(widget, name) {
    if (!output) return;
    GLib.mkdir_with_parents(output, 0o700);
    const width = widget.get_width(), height = widget.get_height();
    let node;
    for (let attempt = 0; attempt < 10; attempt++) {
        const snapshot = new Gtk.Snapshot();
        Gtk.WidgetPaintable.new(widget).snapshot(snapshot, width, height);
        node = snapshot.to_node();
        if (node) break;
        await wait(100);
    }
    check(node, 'No support render node');
    const bounds = new Graphene.Rect();
    bounds.init(0, 0, width, height);
    check(window.get_renderer().render_texture(node, bounds).save_to_png(output + '/' + name + '.png'),
        'Support screenshot could not be saved');
}

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    run().catch(error => printerr(`${error}\n${error.stack}`)).finally(() => {
        GLib.source_remove(deadline); loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();
System.exit(exitCode);
