import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';
Adw.init();
globalThis.logError=(e,m)=>printerr(`${m}: ${e.stack ?? e}`);
const root=ARGV[0],controlPath=GLib.get_home_dir()+'/.local/libexec/icon-normalizer/control.py';
const source=Gio.SettingsSchemaSource.new_from_directory(root+'/schemas',Gio.SettingsSchemaSource.get_default(),false);
const settings=new Gio.Settings({settings_schema:source.lookup('org.gnome.shell.extensions.icon-normalizer',false)});
settings.set_string('ui-language','zh');
const {buildPreferences}=await import(Gio.File.new_for_path(root+'/ui/preferences.js').get_uri());
const window=new Adw.PreferencesWindow({default_width:420,default_height:560});
const pages=buildPreferences(window,{controlPath,settings});
const check=(v,m)=>{if(!v)throw new Error(m);};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
const loop=GLib.MainLoop.new(null,false);let code=1;
const timeout=GLib.timeout_add(GLib.PRIORITY_DEFAULT,20000,()=>{printerr('Language test timed out');loop.quit();return GLib.SOURCE_REMOVE;});
async function run(){
    window.present();await pages.ready;
    const config=Gio.File.new_for_path(GLib.get_home_dir()+'/.local/state/icon-normalizer/config.json');
    const before=config.load_contents(null)[1];
    pages.rules._targetSpin.set_value(91);
    pages.apps._groups[0].names=['Rules'];
    pages.apps._render();
    pages.apps._search.set_text('Rules');await wait(250);
    const revision=pages.rules._loadedRevision;
    window.set_visible_page(pages.maint.page);
    // Drive the real language selector, not a translator test hook.
    pages.maint._languageRow.set_selected(2);
    await wait(100);await pages.ready;
    check(pages.rules.page.title==='Rules','English title missing');
    check(pages.maint.page===window.get_visible_page(),'Page selection was lost');
    check(pages.rules._targetSpin.get_value()===91 && pages.rules._dirty,'Unsaved draft was lost');
    check(pages.rules._loadedRevision===revision,'Draft revision was replaced');
    check(pages.rules._saveApply.label==='Save and apply','Primary button not translated');
    check(pages.apps._search.get_text()==='Rules','Search was changed');
    check(pages.apps._store.get_item(0).group_title==='Rules','App name was translated');
    check(pages.apps._pills.buttons.get('all').label==='All','Filters not translated');
    check(pages.apps._store.get_item(0).subtitle.includes('83%'),'Draft leaked into saved-policy list');
    const confirmation=pages.maint._confirmRevert();
    check(confirmation.heading==='Restore all desktop icons?','Confirmation heading not translated');
    check(!/\p{Script=Han}/u.test(confirmation.body),'Chinese leaked into confirmation');
    confirmation.response('cancel');
    pages.maint._languageRow.set_selected(1);await wait(100);await pages.ready;
    check(pages.rules.page.title==='规则','Chinese title not restored');
    check(pages.rules._targetSpin.get_value()===91,'Draft lost when switching back');
    check(pages.apps._store.get_item(0).group_title==='Rules','App name changed when switching back');
    const after=config.load_contents(null)[1];
    check(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,new GLib.Bytes(before))===
        GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,new GLib.Bytes(after)), 'Language switch changed icon policy');
    window.close();
    // Closing disconnects the settings handler; a later preference change is safe.
    settings.set_string('ui-language','en');await wait(50);
    print(JSON.stringify({ok:true,live_language_switch:true,draft_preserved:true,revision_preserved:true,
        confirmation_translated:true,config_unchanged:true,close_disconnect:true}));code=0;
}
GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{run().catch(e=>printerr(`${e}\n${e.stack}`)).finally(()=>{GLib.source_remove(timeout);loop.quit();});return GLib.SOURCE_REMOVE;});
await loop.runAsync();System.exit(code);
