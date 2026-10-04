"""Real GNOME prefs loader/GTK4, against an isolated GTK3 backend fixture."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

REPO=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/'tests/backend'))
from harness import Sandbox, make_desktop

#: GTK must attach to the live display/session; the sandboxed XDG_RUNTIME_DIR
#: from tests/isolation.py would hide the Wayland socket from the toolkit.
SESSION_KEYS=('XDG_RUNTIME_DIR','WAYLAND_DISPLAY','DISPLAY','DBUS_SESSION_BUS_ADDRESS')


class PreferencesRuntime(unittest.TestCase):
    def test_shell_stylesheet_real_parser(self):
        env=dict(os.environ)
        env['GI_TYPELIB_PATH']='/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-51:'+env.get('GI_TYPELIB_PATH','')
        env['LD_LIBRARY_PATH']='/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-51:'+env.get('LD_LIBRARY_PATH','')
        result=subprocess.run(['gjs','-m',str(REPO/'tests/frontend/shell-css-smoke.mjs'),
                               str(REPO/'extension')],env=env,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])

    def run_fixture(self,script,compact=False,language='zh'):
        if not shutil.which('gjs'):
            self.skipTest('gjs unavailable')
        with Sandbox() as box:
            if compact:
                box.write_config(target=0.83,inner=0.70)
            box.base_icon('fixture-ui',200)
            make_desktop(box.system_apps/'one.desktop','Fixture UI','fixture-ui')
            backend=box.home/'.local/libexec/icon-normalizer'
            shutil.copytree(REPO/'backend',backend,ignore=shutil.ignore_patterns('__pycache__'))
            if script == 'profiles-compat-smoke.mjs':
                # Emulate the old companion's status shape at the CLI boundary.
                (backend/'control.py').write_text("import sys\nfrom icon_normalizer import control\nnative_status = control.op_status\ndef legacy_status(args, ctx):\n    result = native_status(args, ctx)\n    result['backend_version'] = '3.0.2'\n    result.pop('theme_follow', None)\n    return result\ncontrol.OPERATIONS['status'] = legacy_status\nsys.exit(control.main())\n")
            env=box.env()
            for key in SESSION_KEYS:
                if key in os.environ:
                    env[key]=os.environ[key]
            if not (env.get('WAYLAND_DISPLAY') or env.get('DISPLAY')):
                self.skipTest('no display server available for GTK runtime smoke')
            env['GTK_A11Y']='none'
            env['LANGUAGE']='zh_CN'
            # Match the paths set by GNOME's preferences launcher for Shew.
            env['GI_TYPELIB_PATH']='/usr/lib/gnome-shell/girepository-1.0:'+env.get('GI_TYPELIB_PATH','')
            env['LD_LIBRARY_PATH']='/usr/lib/gnome-shell:'+env.get('LD_LIBRARY_PATH','')
            arguments=[str(REPO/'extension')]
            if script=='responsive-smoke.mjs': arguments+=['','fixture',language]
            result=subprocess.run(['gjs','-m',str(REPO/'tests/frontend'/script),
                                   *arguments],env=env,capture_output=True,text=True,timeout=75)
            self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
            self.assertNotIn('JS ERROR',result.stderr)
            self.assertNotIn('Gjs-CRITICAL',result.stderr)
            self.assertNotIn('Gtk-CRITICAL',result.stderr)
            self.assertNotIn('Gtk-WARNING',result.stderr)
            self.assertNotIn('Adwaita-WARNING',result.stderr)
            self.assertNotIn('icon-normalizer:',result.stderr)
            records=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
            if script == 'support-smoke.mjs':
                self.assertFalse((box.state/'last-scan.json').exists(),
                                 'Support UI must not scan or invoke the backend')
            else:
                scan=json.loads((box.state/'last-scan.json').read_text())
                self.assertEqual(scan['groups'][0]['names'],['Fixture UI'])
            return records

    def test_gnome_loader_constructs_three_pages(self):
        records=self.run_fixture('preferences-loader-smoke.mjs')
        self.assertTrue(any(r.get('ok') and len(r.get('page_titles',[]))==3 for r in records))

    def test_preview_sizes_and_revert_confirmation(self):
        records=self.run_fixture('dialogs-smoke.mjs')
        self.assertTrue(any(r.get('ok') and r.get('preview_sizes')==[32,48,64,128,256]
                            and r.get('revert_confirmation')=='cancelled' for r in records))

    def test_responsive_pages_and_saved_policy(self):
        records=self.run_fixture('responsive-smoke.mjs',compact=True)
        result=next(r for r in records if r.get('ok'))
        self.assertEqual(result['saved_policy_controls'],[83,2,70])
        self.assertEqual(len(result['dimensions']),18)
        self.assertTrue(result['dark_light'])
        self.assertTrue(result['preview_responsive'])
        self.assertTrue(result['policy_readonly_on_open'])
        self.assertTrue(result['fixture_save_conflict_checked'])
        lists=[r for r in result['dimensions'] if r['page']=='apps']
        self.assertLess(lists[-1]['list_height'],lists[0]['list_height'])

    def test_english_responsive_pages(self):
        result=next(r for r in self.run_fixture('responsive-smoke.mjs',compact=True,language='en') if r.get('ok'))
        self.assertEqual(result['language'],'en')
        self.assertEqual(len(result['dimensions']),18)
        self.assertTrue(result['fixture_save_conflict_checked'])

    def test_legacy_companion_has_upgrade_hint_and_disabled_new_features(self):
        result=next(r for r in self.run_fixture('profiles-compat-smoke.mjs',compact=True) if r.get('ok'))
        self.assertTrue(result['upgrade_hint'])
        self.assertTrue(result['old_backend_core_ui_works'])
        self.assertTrue(result['new_features_disabled'])

    def test_named_profiles_real_dialogs_and_conflicts(self):
        result=next(r for r in self.run_fixture('profiles-smoke.mjs',compact=True) if r.get('ok'))
        self.assertTrue(result['profiles_crud'])
        self.assertTrue(result['concurrent_conflict'])
        self.assertTrue(result['profile_language_safe'])
        self.assertTrue(result['config_unchanged'])

    def test_language_switch_preserves_draft(self):
        result=next(r for r in self.run_fixture('language-smoke.mjs',compact=True) if r.get('ok'))
        self.assertTrue(result['draft_preserved'])
        self.assertTrue(result['revision_preserved'])
        self.assertTrue(result['config_unchanged'])
        self.assertTrue(result['close_disconnect'])

    def test_support_dialogs_languages_and_responsive_layout(self):
        result=next(r for r in self.run_fixture('support-smoke.mjs') if r.get('ok'))
        self.assertEqual(result['payment_methods'],['wechat','alipay'])
        self.assertEqual(len(result['dimensions']),8)
        self.assertTrue(result['open_dialog_language_switch'])
        self.assertTrue(result['close_cleanup'])


if __name__=='__main__':
    unittest.main()
