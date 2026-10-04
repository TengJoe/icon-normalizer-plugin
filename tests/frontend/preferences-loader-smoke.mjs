import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

for (const name of ['gnome-shell-dbus-interfaces.gresource', 'org.gnome.Shell.Extensions.src.gresource'])
    Gio.resources_register(Gio.Resource.load('/usr/share/gnome-shell/' + name));
Adw.init();
const root = ARGV[0];
const [, bytes] = Gio.File.new_for_path(root + '/metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(bytes));
globalThis.logError = (err, message) => printerr(`${message}: ${err.stack ?? err}`);
// Surface the original construction error before the loader's error-page
// formatter can obscure it in this standalone GJS harness.
try {
    const {default: Prefs} = await import(Gio.File.new_for_path(root + '/prefs.js').get_uri());
    const preflight = new Adw.PreferencesWindow();
    const prefs = new Prefs({...metadata, dir: Gio.File.new_for_path(root), path: root});
    prefs.fillPreferencesWindow(preflight);
    preflight.close();
} catch (err) {
    printerr(`PREFS CONSTRUCTION ERROR: ${String(err)}\n${err.stack ?? ''}`);
    System.exit(1);
}
const {ExtensionPrefsDialog} = await import('resource:///org/gnome/Shell/Extensions/js/extensionPrefsDialog.js');
const loop = GLib.MainLoop.new(null, false);
const dialog = new ExtensionPrefsDialog({dir: Gio.File.new_for_path(root), path: root, metadata});
const titles = [];
const nativeAdd = dialog.add.bind(dialog);
dialog.add = page => { titles.push(page.title); nativeAdd(page); };
let exitCode = 1;
const deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
    printerr('Preferences did not finish loading');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
dialog.connect('loaded', () => {
    const ok = titles.length === 3 && titles.join(',') === '规则,应用图标,维护';
    print(JSON.stringify({ok, loader: 'GNOME 51 ExtensionPrefsDialog', page_titles: titles}));
    exitCode = ok ? 0 : 1;
    GLib.source_remove(deadline);
    // Drain actual asynchronous read requests without applying or changing policy.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        dialog.close(); loop.quit(); return GLib.SOURCE_REMOVE;
    });
});
await loop.runAsync();
System.exit(exitCode);
