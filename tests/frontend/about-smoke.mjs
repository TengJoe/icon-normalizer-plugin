import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

Adw.init();
globalThis.logError = (error, message) => printerr(`${message}: ${error.stack ?? error}`);
const root = ARGV[0];
const {About} = await import(Gio.File.new_for_path(root + '/prefs/about.js').get_uri());
const {setLanguage, t} = await import(Gio.File.new_for_path(root + '/shared/i18n.js').get_uri());
const {ensureCss, translateWidgetTree} = await import(Gio.File.new_for_path(root + '/prefs/uiCommon.js').get_uri());
ensureCss(Gio.File.new_for_path(root + '/prefs/uiCommon.js').get_uri(), '../preferences.css');
const wait = ms => new Promise(resolve => GLib.timeout_add(0, ms, () => {resolve(); return GLib.SOURCE_REMOVE;}));
const check = (value, message) => {if (!value) throw new Error(message);};
const window = new Adw.PreferencesWindow();
const page = new Adw.PreferencesPage();
const about = new About(window);
page.add(about.group);
window.add(page);
const loop = GLib.MainLoop.new(null, false);
let exitCode = 1;
async function run() {
    const [, bytes] = Gio.File.new_for_path(root + '/metadata.json').load_contents(null);
    check(!('donations' in JSON.parse(new TextDecoder().decode(bytes))), 'Donation metadata remains');
    check(!Gio.File.new_for_path(root + '/assets/support').query_exists(null), 'Payment assets remain');
    const dimensions = [];
    window.present();
    for (const language of ['zh', 'en']) {
        setLanguage(language);
        translateWidgetTree(window);
        check(about.group.title === t('关于'), 'About heading not translated');
        for (const [width, height] of [[420, 560], [960, 760]]) {
            window.set_default_size(width, height);
            await wait(150);
            dimensions.push({language, width: window.get_width(), height: window.get_height()});
        }
    }
    window.close();
    check(about._scope.closed, 'About requests were not cancelled on close');
    about.destroy();
    check(about._window === null, 'About window retained');
    print(JSON.stringify({ok: true, dimensions, no_donations: true, close_cleanup: true}));
    exitCode = 0;
}
GLib.idle_add(0, () => {
    run().catch(error => printerr(error.stack)).finally(() => {window.close(); loop.quit();});
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();
System.exit(exitCode);
