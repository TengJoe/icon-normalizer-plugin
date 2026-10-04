import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';
Adw.init(); globalThis.logError=(e,m)=>printerr(`${m}: ${e.stack ?? e}`);
const root=ARGV[0],controlPath=GLib.get_home_dir()+'/.local/libexec/icon-normalizer/control.py';
const source=Gio.SettingsSchemaSource.new_from_directory(root+'/schemas',Gio.SettingsSchemaSource.get_default(),false);
const settings=new Gio.Settings({settings_schema:source.lookup('org.gnome.shell.extensions.icon-normalizer',false)});
settings.set_string('ui-language','zh');
const {buildPreferences}=await import(Gio.File.new_for_path(root+'/ui/preferences.js').get_uri());
const window=new Adw.PreferencesWindow({default_width:420,default_height:560});
const pages=buildPreferences(window,{controlPath,settings});
const check=(v,m)=>{if(!v)throw new Error(m);};
function texts(widget) {
    let result=widget instanceof Gtk.Label ? [widget.label] : [];
    for(let child=widget.get_first_child();child;child=child.get_next_sibling())result=result.concat(texts(child));
    return result;
}
const loop=GLib.MainLoop.new(null,false);let code=1;
const deadline=GLib.timeout_add(0,15000,()=>{printerr('Legacy UI test timed out');loop.quit();return GLib.SOURCE_REMOVE;});
async function run() {
    window.present();await pages.ready;await pages.maint.refresh();
    const profiles=pages.rules._profiles;
    check(texts(profiles._notice.row).some(text=>text.includes('3.1.0')),'Missing old-backend upgrade hint');
    check(!profiles._saveButton.sensitive && !profiles._revision,'Profile controls enabled for old backend');
    check(!pages.maint._followRow.sensitive,'Theme follow enabled for old backend');
    check(pages.maint._followRow.tooltip_text.includes('3.1.0'),'Theme follow upgrade hint missing');
    check(pages.rules._hasPolicy && pages.rules._targetSpin.get_value()===83,'Legacy core policy UI stopped working');
    const profilePath=GLib.get_home_dir()+'/.local/state/icon-normalizer/profiles.json';
    check(!Gio.File.new_for_path(profilePath).query_exists(null),'Upgrade hint created profile data');
    window.close();print(JSON.stringify({ok:true,upgrade_hint:true,old_backend_core_ui_works:true,new_features_disabled:true}));code=0;
}
GLib.idle_add(0,()=>{run().catch(e=>printerr(`${e}\n${e.stack}`)).finally(()=>{GLib.source_remove(deadline);loop.quit();});return GLib.SOURCE_REMOVE;});
await loop.runAsync();System.exit(code);
