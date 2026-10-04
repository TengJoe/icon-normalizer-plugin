import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

globalThis.logError = (error, message) => printerr(`${message}: ${error.stack ?? error}`);
Adw.init();
const root=ARGV[0];
const controlPath=GLib.build_filenamev([GLib.get_home_dir(),'.local','libexec','icon-normalizer','control.py']);
const schemaSource=Gio.SettingsSchemaSource.new_from_directory(root+'/schemas',Gio.SettingsSchemaSource.get_default(),false);
const settings=new Gio.Settings({settings_schema:schemaSource.lookup('org.gnome.shell.extensions.icon-normalizer',false)});
const {buildPreferences}=await import(Gio.File.new_for_path(root+'/ui/preferences.js').get_uri());
const {openPreview}=await import(Gio.File.new_for_path(root+'/ui/previewDialog.js').get_uri());
const {call}=await import(Gio.File.new_for_path(root+'/lib/backendClient.js').get_uri());
const window=new Adw.PreferencesWindow();
const pages=buildPreferences(window,{controlPath,settings});
const loop=GLib.MainLoop.new(null,false);
let code=1;
const deadline=GLib.timeout_add(GLib.PRIORITY_DEFAULT,15000,()=>{
    printerr('Dialog runtime check timed out');loop.quit();return GLib.SOURCE_REMOVE;
});
async function run() {
    // The pages kick off their own initial scans; a first-run scan renders all
    // nine sizes and can exceed the 100ms read-lock budget, so retry on BUSY
    // exactly like AppsPage.refresh() does.
    let scan=null;
    for (let attempt=0; attempt<5; attempt++) {
        scan=await call(controlPath,'scan',{});
        if (scan.ok) break;
        if (scan.error?.code!=='BUSY') break;
        await new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,400,
            ()=>{resolve();return GLib.SOURCE_REMOVE;}));
    }
    if (!scan.ok || scan.result.groups.length!==1) throw new Error(JSON.stringify(scan));
    const sizes=[];
    for (const size of [32,48,64,128,256]) {
        settings.set_int('preview-size',size);
        const preview=openPreview(window,scan.result.groups[0],{controlPath,settings});
        const result=await preview.ready;
        if (!result.ok || result.result.size!==size) throw new Error(JSON.stringify(result));
        preview.close();
        sizes.push(size);
    }
    const confirm=pages.maint._confirmRevert();
    confirm.response('cancel');
    window.close();
    print(JSON.stringify({ok:true,preview_sizes:sizes,revert_confirmation:'cancelled'}));
    code=0;
}
GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{
    run().catch(err=>printerr(`${String(err)}\n${err.stack}`)).finally(()=>{
        GLib.source_remove(deadline);loop.quit();
    });
    return GLib.SOURCE_REMOVE;
});
await loop.runAsync();
System.exit(code);
