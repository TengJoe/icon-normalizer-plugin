// Exercise the real St parser, rather than assuming a regular-expression lint
// proves the stylesheet is accepted by GNOME Shell.
import St from 'gi://St';
import Gio from 'gi://Gio';
const theme = new St.Theme();
const file = Gio.File.new_for_path(ARGV[0] + '/stylesheet.css');
theme.load_stylesheet(file);
theme.unload_stylesheet(file);
print(JSON.stringify({ok: true, parser: 'St.Theme', stylesheet: file.get_path()}));
