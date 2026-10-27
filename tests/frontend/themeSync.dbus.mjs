// Real cross-process dconf notifications on a private session bus.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {syncGtkTheme} from '../../extension/shell/themeSync.js';
const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE; }));
function check(value, message) { if (!value) throw new Error(message); }
const handlers = ['color-scheme', 'accent-color'].map(key => settings.connect(`changed::${key}`,
    () => syncGtkTheme(settings)));
for (const key of ['color-scheme', 'accent-color']) settings.get_string(key);
settings.set_string('gtk-theme', 'Yaru-blue');
settings.set_string('icon-theme', 'DockNormalized');
syncGtkTheme(settings);
for (let round = 0; round < 3; round++) {
    for (const [key, value, expected] of [
        ['accent-color', 'purple', 'Yaru-purple'],
        ['color-scheme', 'prefer-dark', 'Yaru-purple-dark'],
        ['color-scheme', 'default', 'Yaru-purple'],
        ['accent-color', 'blue', 'Yaru-blue'],
    ]) {
        const process = Gio.Subprocess.new(['/usr/bin/gsettings', 'set',
            'org.gnome.desktop.interface', key, value], Gio.SubprocessFlags.STDOUT_SILENCE);
        process.wait_check(null);
        for (let i = 0; i < 40; i++) {
            if (settings.get_string('gtk-theme') === expected &&
                settings.get_string(key) === (value === 'default' ? 'prefer-light' : value)) break;
            await wait(25);
        }
        check(settings.get_string('gtk-theme') === expected, `${round}/${key}: expected ${expected}`);
        check(settings.get_string('color-scheme') !== 'default', 'default was not promoted');
        check(settings.get_string('icon-theme') === 'DockNormalized', 'GTK helper changed icon selection');
    }
}
for (const handler of handlers) settings.disconnect(handler);
settings.set_string('color-scheme', 'prefer-dark');
await wait(100);
check(settings.get_string('gtk-theme') === 'Yaru-blue', 'disconnected helper still ran');
Gio.Settings.sync();
console.log('ok   private dconf: 3 light/dark/accent cycles; disconnect clean');
