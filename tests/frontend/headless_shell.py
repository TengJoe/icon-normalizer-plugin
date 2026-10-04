"""Run the production extension in a disposable GNOME Shell 51.

Usage: python3 tests/frontend/headless_shell.py [proof-directory]
Private HOME/runtime/keyfile settings/session bus; backend uses fixture paths
and a fake systemctl. The live Shell is never replaced or restarted.
"""
import json,os,shutil,signal,subprocess,sys,time,tempfile
from pathlib import Path

REPO=Path(__file__).resolve().parents[2]
output_arg=sys.argv[2] if '--inner' in sys.argv else (sys.argv[1] if len(sys.argv)>1 else None)
OUT=Path(output_arg or tempfile.mkdtemp(prefix='icon-normalizer-shell-proof-')).resolve()
OUT.mkdir(parents=True,exist_ok=True)
if '--inner' not in sys.argv:
    p=subprocess.run(['dbus-run-session','--','python3',__file__,'--inner',str(OUT)],
                     capture_output=True,text=True,timeout=45)
    (OUT/'headless-shell-launcher.log').write_text(p.stdout+'\n'+p.stderr)
    print(p.stdout,p.stderr[-2500:])
    sys.exit(p.returncode)

sys.path.insert(0,str(REPO/'tests/backend'))
from harness import Sandbox,make_desktop
UUID='icon-normalizer@joeydeng.local'
HARNESS='icon-normalizer-acceptance@fixture.local'
with Sandbox() as box:
    box.base_icon('fixture-headless',100)
    make_desktop(box.system_apps/'one.desktop','Fixture Headless','fixture-headless')
    backend=box.home/'.local/libexec/icon-normalizer'
    shutil.copytree(REPO/'backend',backend,ignore=shutil.ignore_patterns('__pycache__'))
    extensions=box.home/'.local/share/gnome-shell/extensions'
    target=extensions/UUID
    shutil.copytree(REPO/'extension',target)
    test=extensions/HARNESS
    test.mkdir()
    (test/'metadata.json').write_text(json.dumps({'uuid':HARNESS,'name':'Fixture acceptance',
        'description':'Disposable isolated test','shell-version':['51']}))
    report=box.root/'result.json'
    script=r'''
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{
    resolve();return GLib.SOURCE_REMOVE;
}));
const check=(value,message)=>{if(!value)throw new Error(message);};
export default class Acceptance extends Extension {
    enable() {
        this._id=GLib.timeout_add(GLib.PRIORITY_DEFAULT,1000,()=>{
            this._id=0;this.run().catch(err=>this.finish({ok:false,error:String(err),stack:err.stack}));
            return GLib.SOURCE_REMOVE;
        });
    }
    disable() {if(this._id)GLib.source_remove(this._id);}
    finish(result) {GLib.file_set_contents(REPORT,JSON.stringify(result));}
    async idle(extension) {
        for(let i=0;i<200;i++){if(extension._pending.size===0)return;await wait(50);}
        throw new Error('backend request did not settle');
    }
    async run() {
        const record=Main.extensionManager.lookup('icon-normalizer@joeydeng.local');
        check(record?.state===ExtensionState.ACTIVE,'extension is not ACTIVE: '+record?.error);
        const extension=record.stateObj;
        await this.idle(extension);
        let indicator=extension._indicator;
        check(indicator,'panel preference did not produce indicator');
        check(Main.panel.statusArea['icon-normalizer']===indicator._indicator,'panel role missing');
        check(indicator.menu._getMenuItems().length===7,'incomplete menu');
        check(indicator._icon instanceof St.Icon,'top bar did not use a symbolic icon');
        const calls=[];
        const request=extension._request.bind(extension);
        extension._request=(...args)=>{calls.push(args);return request(...args);};
        const status={installed:true,automatic:'on',revision:'a'.repeat(64),overlay_in_use:true,
            active_theme:'DockNormalized',last_apply_at:'2026-10-04T04:00:00+08:00',summary:{managed_icons:1}};
        indicator.update(status,{ok:true,result:status});
        check(calls.length===0,'programmatic refresh sent an automation request');
        const capture=async language=>{
            extension._settings.set_string('ui-language',language);
            await wait(100);
            check(indicator._nameLabel.text===(language==='en'?'Icon Normalizer':'图标统一'),
                  'menu did not switch languages');
            check(calls.length===0,'language change sent a backend request');
            indicator.menu.open();
            await wait(350);
            const [content]=await new Shell.Screenshot().screenshot_stage_to_content();
            const [mx,my]=indicator.menu.actor.get_transformed_position();
            const [mw,mh]=indicator.menu.actor.get_transformed_size();
            check(mw<460,'menu expanded excessively: '+mw);
            const x=Math.max(0,Math.floor(mx)-8),width=Math.min(global.stage.width-x,Math.ceil(mw)+16);
            const stream=Gio.File.new_for_path(OUTPUT+'/menu-'+language+'.png')
                .replace(null,false,Gio.FileCreateFlags.PRIVATE,null);
            await Shell.Screenshot.composite_to_stream(content.get_texture(),x,0,width,
                Math.min(global.stage.height,Math.ceil(my+mh)+8),1,null,0,0,1,stream);
            stream.close(null);
            indicator.menu.close();
        };
        await capture('zh');await capture('en');
        const partial={...status,automatic:'partial'};
        indicator.update(partial,{ok:true});
        check(!indicator._autoItem.state,'partial state displayed as fully on');
        indicator.update(status,{ok:true,result:status});
        indicator._autoItem.setToggleState(false);
        await this.idle(extension);
        check(calls.filter(c=>c[0]==='automation').length===1,'user toggle routing failed');
        indicator._checkItem.emit('activate',null);
        await this.idle(extension);
        indicator._applyItem.emit('activate',null);
        indicator._applyItem.emit('activate',null);
        await this.idle(extension);
        check(calls.filter(c=>c[0]==='scan').length===1,'scan routing failed');
        check(GLib.file_test(GLib.getenv('ICON_NORMALIZER_STATE')+'/manifest.json',GLib.FileTest.EXISTS),
              'apply did not commit fixture manifest');
        const oldButton=indicator._indicator;
        extension.disable();
        check(!Main.panel.statusArea['icon-normalizer'],'disable leaked panel role');
        extension.enable();
        await this.idle(extension);
        indicator=extension._indicator;
        check(indicator._indicator!==oldButton,'re-enable reused destroyed actor');
        check(indicator.menu._getMenuItems().length===7,'re-enabled menu missing');
        this.finish({ok:true,shell:'51.0',state:'ACTIVE',menu_items:7,symbolic_icon:true,
            bilingual:true,automation_guard:true,scan:true,apply:true,disable_reenable:true});
    }
}
'''.replace('REPORT',json.dumps(str(report))).replace('OUTPUT',json.dumps(str(OUT)))
    (test/'extension.js').write_text(script)
    env=box.env()
    env['DBUS_SESSION_BUS_ADDRESS']=os.environ['DBUS_SESSION_BUS_ADDRESS']
    env['GSETTINGS_BACKEND']='keyfile'
    env['XDG_CONFIG_HOME']=str(box.home/'.config')
    env['XDG_CACHE_HOME']=str(box.home/'.cache')
    env['XDG_DATA_HOME']=str(box.home/'.local/share')
    env['XDG_DATA_DIRS']='/usr/local/share:/usr/share'
    env['LIBGL_ALWAYS_SOFTWARE']='1'
    env['GTK_A11Y']='none'
    env.pop('DISPLAY',None);env.pop('WAYLAND_DISPLAY',None)
    for args in [
        ['gsettings','set','org.gnome.shell','enabled-extensions',json.dumps([UUID,HARNESS])],
        ['gsettings','--schemadir',str(target/'schemas'),'set',
            'org.gnome.shell.extensions.icon-normalizer','show-panel-indicator','true'],
    ]:
        subprocess.run(args,env=env,check=True,capture_output=True,text=True)
    with (OUT/'headless-shell.log').open('w') as log:
        p=subprocess.Popen(['gnome-shell','--headless','--wayland','--no-x11',
            '--virtual-monitor','1024x768','--mode=user','--wayland-display=icon-normalizer-fixture'],
            env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            deadline=time.monotonic()+30
            while time.monotonic()<deadline and p.poll() is None and not report.exists():time.sleep(.1)
            if report.exists():result=json.loads(report.read_text())
            else:result={'ok':False,'error':'No report','shell_exit':p.poll()}
            (OUT/'headless-shell.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        finally:
            if p.poll() is None:
                os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    print(json.dumps(result,ensure_ascii=False))
    sys.exit(0 if result.get('ok') else 1)
