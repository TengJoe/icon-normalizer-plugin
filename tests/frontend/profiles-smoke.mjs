import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
Adw.init();
// Private HOME lacks the live DockNormalized theme advertised by the portal.
// Use a system theme for test UI symbols without changing desktop GSettings.
Gtk.Settings.get_default().gtk_icon_theme_name = 'Adwaita';
globalThis.logError = (e,m) => printerr(`${m}: ${e.stack ?? e}`);
const root = ARGV[0], controlPath = GLib.get_home_dir()+'/.local/libexec/icon-normalizer/control.py';
const source = Gio.SettingsSchemaSource.new_from_directory(root+'/schemas', Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.icon-normalizer', false)});
settings.set_string('ui-language','zh');
const {buildPreferences} = await import(Gio.File.new_for_path(root+'/ui/preferences.js').get_uri());
const {call} = await import(Gio.File.new_for_path(root+'/lib/backendClient.js').get_uri());
const window = new Adw.PreferencesWindow({default_width: 420, default_height: 560});
const pages = buildPreferences(window, {controlPath, settings});
const check = (value,message) => {if (!value) throw new Error(message);};
const wait = ms => new Promise(resolve => GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
function capture(name) {
    if (!ARGV[1]) return;
    GLib.mkdir_with_parents(ARGV[1],0o700);
    const width=window.get_width(),height=window.get_height(),snapshot=new Gtk.Snapshot();
    Gtk.WidgetPaintable.new(window).snapshot(snapshot,width,height);
    const node=snapshot.to_node(); check(node,'Missing native render node');
    const bounds=new Graphene.Rect();bounds.init(0,0,width,height);
    check(window.get_renderer().render_texture(node,bounds).save_to_png(ARGV[1]+'/'+name+'.png'),'PNG export failed');
}
const loop=GLib.MainLoop.new(null,false); let code=1;
const timeout=GLib.timeout_add(0,25000,()=>{printerr('Profile UI test timed out');loop.quit();return GLib.SOURCE_REMOVE;});
const config=Gio.File.new_for_path(GLib.get_home_dir()+'/.local/state/icon-normalizer/config.json');
const digest=()=>GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,new GLib.Bytes(config.load_contents(null)[1]));
async function run() {
    window.present(); await pages.ready; window.set_visible_page(pages.rules.page);
    const profiles=pages.rules._profiles; check(profiles._profiles.length===0,'Nonempty initial catalog');
    const before=digest(); pages.rules._targetSpin.set_value(91);
    check(profiles._saveButton.sensitive,'Save profile stayed disabled after policy read');
    const save=profiles.openDialog(); save.entry.set_text('Rules'); save.dialog.response('save'); await profiles.lastMutation;
    check(profiles._profiles.length===1,'Create did not persist');
    check(profiles._profiles[0].parameters.target===.91,'Draft parameters missing');
    check(digest()===before,'Saving a profile changed active policy');
    profiles._saveButton.grab_focus(); await wait(200); capture('custom-profiles-zh');
    const profile=profiles._profiles[0];
    const rename=profiles.openDialog(profile); rename.entry.set_text('<b>Rules</b>'); rename.dialog.response('save'); await profiles.lastMutation;
    check(profiles._rows[0].title==='<b>Rules</b>' && !profiles._rows[0].use_markup,'User name was rendered as markup');
    const renameBack=profiles.openDialog(profiles._profiles[0]); renameBack.entry.set_text('Rules'); renameBack.dialog.response('save'); await profiles.lastMutation;
    pages.maint._languageRow.set_selected(2); await wait(120);
    check(profiles.group.title==='Custom profiles','Profile group not translated');
    check(profiles._rows[0].title==='Rules','User profile name was translated');
    check(profiles._saveButton.label==='Save as custom profile…','Save action not translated');
    profiles._saveButton.grab_focus(); await wait(200); capture('custom-profiles-en');
    pages.rules._targetSpin.set_value(83); profiles._rows[0]._useButton.emit('clicked');
    check(pages.rules._targetSpin.get_value()===91 && pages.rules._dirty,'Use failed to fill the draft');
    check(digest()===before,'Using a profile silently applied it');
    // Concurrent catalog change must conflict instead of deleting another window's data.
    const external=await call(controlPath,'profiles.save',{name:'Second window',parameters:profile.parameters,
        expected_profiles_revision:profiles._revision}); check(external.ok,'Second window fixture failed');
    const deletion=profiles.confirmDelete(profiles._profiles[0]); deletion.response('delete'); await profiles.lastMutation;
    check(profiles._profiles.length===1,'Stale delete changed local catalog');
    check(profiles._notice.row.visible,'Conflict was not displayed'); await profiles.refresh();
    check(profiles._profiles.length===2,'Reload did not see second-window changes');
    for (const value of [...profiles._profiles]) {
        const dialog=profiles.confirmDelete(value); dialog.response('delete'); await profiles.lastMutation;
    }
    check(profiles._profiles.length===0,'Delete did not persist'); check(digest()===before,'Profile CRUD changed config');
    check(pages.maint._followRow.title==='Follow icon theme','Theme-follow option not translated');
    window.close(); print(JSON.stringify({ok:true,profiles_crud:true,profile_markup_safe:true,
        concurrent_conflict:true,profile_language_safe:true,profile_use_draft_only:true,config_unchanged:true})); code=0;
}
GLib.idle_add(0,()=>{run().catch(e=>printerr(`${e}\n${e.stack}`)).finally(()=>{GLib.source_remove(timeout);loop.quit();});return GLib.SOURCE_REMOVE;});
await loop.runAsync(); System.exit(code);
