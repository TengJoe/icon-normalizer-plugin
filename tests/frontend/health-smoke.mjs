import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Graphene from 'gi://Graphene';
import System from 'system';
Adw.init();
Gtk.Settings.get_default().gtk_icon_theme_name = 'Adwaita';
globalThis.logError=(error,message)=>printerr(`${message}: ${error.stack ?? error}`);
const root=ARGV[0];
const settingsSource=Gio.SettingsSchemaSource.new_from_directory(root+'/schemas',Gio.SettingsSchemaSource.get_default(),false);
const settings=new Gio.Settings({settings_schema:settingsSource.lookup('org.gnome.shell.extensions.icon-normalizer',false)});
settings.set_string('ui-language','zh');
const {buildPreferences}=await import(Gio.File.new_for_path(root+'/ui/preferences.js').get_uri());
const {call}=await import(Gio.File.new_for_path(root+'/lib/backendClient.js').get_uri());
const controlPath=GLib.get_home_dir()+'/.local/libexec/icon-normalizer/control.py';
const window=new Adw.PreferencesWindow({default_width:420,default_height:560});
const pages=buildPreferences(window,{controlPath,settings});
const check=(value,message)=>{if(!value)throw new Error(message);};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
const loop=GLib.MainLoop.new(null,false); let code=1;
const timeout=GLib.timeout_add(0,30000,()=>{printerr('Health test timed out');loop.quit();return GLib.SOURCE_REMOVE;});
function capture(name,widget=window) {
    if (!ARGV[1]) return;
    GLib.mkdir_with_parents(ARGV[1],0o700);
    const width=widget.get_width(),height=widget.get_height(),snapshot=new Gtk.Snapshot();
    Gtk.WidgetPaintable.new(widget).snapshot(snapshot,width,height);
    const node=snapshot.to_node(),bounds=new Graphene.Rect(); bounds.init(0,0,width,height);
    check(node && widget.get_renderer().render_texture(node,bounds).save_to_png(ARGV[1]+'/'+name+'.png'),'Screenshot failed');
}
async function run() {
    window.present(); await pages.ready;
    const status=await call(controlPath,'status',{});
    check((await call(controlPath,'apply',{expected_revision:status.result.revision,activate:false})).ok,'Fixture apply failed');
    const path=Gio.File.new_for_path(GLib.get_home_dir()+'/.local/state/icon-normalizer/last-error.json');
    path.replace_contents(JSON.stringify({code:'OWNERSHIP_CONFLICT',message:'Fixture external edit',
        first_seen_unix:100,last_seen_unix:200,count:3,details:{conflict_count:2,conflicts:[{
            path:'/fixture/icons/one.png',expected_sha256:'a'.repeat(64),actual_sha256:'b'.repeat(64)}]}}),null,false,Gio.FileCreateFlags.PRIVATE,null);
    for (const language of ['zh','en']) {
        settings.set_string('ui-language',language); await wait(150);
        await pages.maint.refresh(); window.set_visible_page(pages.maint.page);
        const maintenance=pages.maint;
        check(maintenance._badgeHealth.get_text()===(language==='zh'?'受阻':'Blocked'),'Health label');
        check(maintenance._rowHealth.get_subtitle().includes(language==='zh'?'2 个冲突文件':'2 conflicting files'),'Conflict count');
        check(maintenance._healthDetails.get_visible(),'Missing details button');
        await wait(150); capture('maintenance-health-'+language);
        const dialog=maintenance._showHealthDetails();
        check(dialog!==null,'Details did not open');
        const view=dialog.get_extra_child().get_child();
        const buffer=view.get_buffer();
        const contents=buffer.get_text(buffer.get_start_iter(),buffer.get_end_iter(),true);
        check(contents.includes('a'.repeat(64)) && contents.includes('/fixture/icons/one.png'),'Conflict receipt missing');
        check(contents.includes(language==='zh'?'首次发现':'First detected'),'Missing first seen');
        await wait(150); capture('maintenance-details-'+language,dialog);
        dialog.response('close'); await wait(100);
    }
    const current=await call(controlPath,'status',{});
    check((await call(controlPath,'apply',{expected_revision:current.result.revision,activate:false})).ok,'Recovery apply failed');
    await pages.maint.refresh();
    check(!pages.maint._healthDetails.get_visible(),'Recovered error stayed visible');
    check(pages.maint._badgeHealth.get_text()==='Succeeded','Recovery status');
    print(JSON.stringify({ok:true,bilingual_health:true,conflict_details:true,recovery:true}));
    code=0;
}
GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{
    run().catch(error=>printerr(error.stack ?? error)).finally(()=>{
        GLib.source_remove(timeout);window.close();loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();System.exit(code);
