"""Installer failures and exact state preservation over real temp file trees."""
from contextlib import ExitStack, redirect_stdout
import fcntl
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO/'tools'))
from layout import resolve, UNITS, TRIGGER_UNITS
spec = importlib.util.spec_from_file_location('safety_installer', REPO/'tools'/'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='icon-install-safety-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.layout = resolve(self.root/'home')
        for p in (self.layout.libexec, self.layout.extension, self.layout.units, self.layout.state):
            p.mkdir(parents=True)
        self.layout.control_path.write_text('old-backend')
        (self.layout.extension/'metadata.json').write_text('old-extension')
        (self.layout.extension/'schemas').mkdir()
        (self.layout.extension/'schemas'/'gschemas.compiled').write_bytes(b'old-schema')
        for u in UNITS:
            (self.layout.units/u).write_text('old-unit')
        (self.layout.units/'unrelated.timer').write_text('unrelated-before')
        (self.layout.state/'config.json').write_text('{"base_theme":"FixtureBase"}')
        self.layout.theme.mkdir(parents=True)
        (self.layout.theme/'.icon-normalizer-owned').write_text('icon-normalizer-owned-v1\n')
        self.states = {u:{'enabled':False,'active':False} for u in TRIGGER_UNITS}
        self.calls = []
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, kwargs in {
            'resolve':{'return_value':self.layout},
            'precheck':{'return_value':[]},
            'unit_states':{'side_effect':lambda:json.loads(json.dumps(self.states))},
            'systemctl':{'side_effect':self.systemctl},
            'status_probe':{'return_value':(True,'')},
            'wait_service_idle':{'return_value':True},
        }.items():
            self.stack.enter_context(patch.object(installer,name,**kwargs))
        self.stack.enter_context(redirect_stdout(io.StringIO()))

    def systemctl(self, args, **kwargs):
        self.calls.append(args)
        for u in args[1:]:
            if u not in self.states:
                continue
            if args[0] in ('enable','disable'):
                self.states[u]['enabled'] = args[0]=='enable'
                if '--now' in args:
                    self.states[u]['active'] = args[0]=='enable'
            elif args[0] in ('start','stop'):
                self.states[u]['active'] = args[0]=='start'
        return 0,'',''

    def assert_old_installation(self):
        self.assertEqual(self.layout.control_path.read_text(),'old-backend')
        self.assertEqual((self.layout.extension/'metadata.json').read_text(),'old-extension')
        self.assertEqual((self.layout.extension/'schemas'/'gschemas.compiled').read_bytes(),b'old-schema')
        self.assertTrue(all((self.layout.units/u).read_text()=='old-unit' for u in UNITS))

    def test_upgrade_preserves_every_enabled_active_combination(self):
        # Each trigger independently spans all four states, including partial.
        for enabled, active in [(False,False),(True,False),(False,True),(True,True)]:
            with self.subTest(enabled=enabled,active=active):
                self.states = {TRIGGER_UNITS[0]:{'enabled':enabled,'active':active},
                               TRIGGER_UNITS[1]:{'enabled':not enabled,'active':not active}}
                before=json.loads(json.dumps(self.states))
                self.assertEqual(installer.install(True),0)
                self.assertEqual(self.states,before)

    def test_post_probe_failure_restores_extension_schema_and_rules(self):
        self.states={u:{'enabled':True,'active':True} for u in TRIGGER_UNITS}
        rules=self.layout.state/'overrides.json'
        original=b'{"schema_version":1,"icons":{}}'
        rules.write_bytes(original)
        def fail_probe(layout):
            (layout.units/'created-during-upgrade.timer').write_text('concurrent-user-unit')
            return False,'injected'
        with patch.object(installer,'status_probe',side_effect=fail_probe):
            self.assertEqual(installer.install(True),5)
        self.assert_old_installation()
        self.assertEqual(rules.read_bytes(),original)
        self.assertEqual((self.layout.units/'created-during-upgrade.timer').read_text(),'concurrent-user-unit')
        self.assertTrue(all(s=={'enabled':True,'active':True} for s in self.states.values()))

    def test_custom_preferences_preserved_on_upgrade_and_failure(self):
        originals = {'profiles.json': b'{"schema_version":1,"profiles":[]}',
                     'theme-follow.json': b'{"schema_version":1,"enabled":false}'}
        for name, data in originals.items(): (self.layout.state/name).write_bytes(data)
        self.assertEqual(installer.install(True), 0)
        for name, data in originals.items(): self.assertEqual((self.layout.state/name).read_bytes(), data)
        def fail_probe(layout):
            for name in originals: (layout.state/name).write_bytes(b'changed-during-failure')
            return False, 'injected'
        with patch.object(installer, 'status_probe', side_effect=fail_probe):
            self.assertEqual(installer.install(True), 5)
        for name, data in originals.items(): self.assertEqual((self.layout.state/name).read_bytes(), data)

    def test_old_snapshot_does_not_own_new_preference_files(self):
        snapshot = installer.snapshot(self.root/'old-snapshot', self.layout)
        manifest_path = snapshot/'snapshot.json'; manifest = json.loads(manifest_path.read_text())
        for name in ['profiles.json', 'theme-follow.json']: manifest['existed'].pop(name, None)
        manifest_path.write_text(json.dumps(manifest))
        for name in ['profiles.json', 'theme-follow.json']: (self.layout.state/name).write_bytes(b'newer-user-data')
        installer.restore_snapshot(snapshot, self.layout)
        for name in ['profiles.json', 'theme-follow.json']:
            self.assertEqual((self.layout.state/name).read_bytes(), b'newer-user-data')

    def test_wait_timeout_aborts_before_code_changes(self):
        with patch.object(installer,'wait_service_idle',return_value=False):
            self.assertEqual(installer.install(True),5)
        self.assert_old_installation()

    def test_stop_failure_aborts_before_code_changes(self):
        with patch.object(installer,'systemctl',return_value=(1,'','refused')):
            self.assertEqual(installer.install(True),5)
        self.assert_old_installation()

    def test_unknown_trigger_state_aborts_without_mutations(self):
        self.states[TRIGGER_UNITS[0]]['enabled']=None
        self.assertEqual(installer.install(True),5)
        self.assertEqual(self.calls,[])
        self.assert_old_installation()

    def test_snapshot_failure_restores_trigger_state(self):
        self.states={u:{'enabled':True,'active':True} for u in TRIGGER_UNITS}
        with patch.object(installer,'snapshot',side_effect=OSError('injected')):
            self.assertEqual(installer.install(True),5)
        self.assert_old_installation()
        self.assertTrue(all(s=={'enabled':True,'active':True} for s in self.states.values()))

    def test_pending_recovery_blocks_upgrade(self):
        (self.layout.state/'settings-pending.json').write_text('{}')
        self.assertEqual(installer.install(True),5)
        self.assert_old_installation()

    def test_manual_writer_lock_blocks_upgrade(self):
        lock=self.layout.state/'sync.lock'
        with open(lock,'a') as held:
            fcntl.flock(held,fcntl.LOCK_EX)
            # Avoid a real 30-second timeout while exercising the same guard.
            real_locked=installer.locked
            with patch.object(installer,'locked',side_effect=lambda p,timeout=0:real_locked(p,0)):
                self.assertEqual(installer.install(True),5)
        self.assert_old_installation()

    def test_keep_backend_has_no_systemctl_mutations(self):
        before={u:(self.layout.units/u).read_bytes() for u in UNITS}
        self.assertEqual(installer.uninstall(True),0)
        self.assertTrue(self.layout.control_path.exists())
        self.assertFalse(self.layout.extension.exists())
        self.assertEqual({u:(self.layout.units/u).read_bytes() for u in UNITS},before)
        self.assertEqual(self.calls,[])

    def test_revert_failures_keep_recovery_backend(self):
        request={'api_version':1,'request_id':'uninstall','operation':'revert'}
        for rc, body in [(5,{**request,'ok':False}),(0,{**request,'ok':False}),
                         (0,{'ok':True}),(0,'garbage')]:
            with self.subTest(rc=rc,body=body):
                payload=json.dumps(body).encode() if isinstance(body,dict) else body.encode()
                result=subprocess.CompletedProcess([],rc,payload,b'')
                with patch.object(installer.subprocess,'run',return_value=result):
                    self.assertEqual(installer.uninstall(False),5)
                self.assert_old_installation()
        with patch.object(installer.subprocess,'run',side_effect=subprocess.TimeoutExpired('revert',140)):
            self.assertEqual(installer.uninstall(False),5)
        self.assert_old_installation()

    def test_legacy_machine_overrides_migrate_with_user_precedence(self):
        legacy=self.layout.libexec/'core'/'overrides.json'
        legacy.parent.mkdir()
        icon=str(self.root/'whale.png')
        entry={'class':'glyph','source_sha256':'a'*64}
        legacy.write_text(json.dumps({'schema_version':1,'icons':{icon:entry}}))
        self.assertEqual(installer.install(True),0)
        target=self.layout.state/'overrides.json'
        self.assertEqual(json.loads(target.read_text())['icons'][icon],entry)
        user={'class':'artwork','source_sha256':'b'*64}
        target.write_text(json.dumps({'schema_version':1,'icons':{icon:user}}))
        original=target.read_bytes()
        self.assertEqual(installer.install(True),0)
        self.assertEqual(target.read_bytes(),original)

    def test_schema_failure_rolls_back_everything(self):
        with patch.object(installer,'install_extension',side_effect=RuntimeError('schema failed')):
            self.assertEqual(installer.install(True),5)
        self.assert_old_installation()

    def test_failed_fresh_install_removes_new_code_and_keeps_unrelated_units(self):
        shutil.rmtree(self.layout.libexec)
        shutil.rmtree(self.layout.extension)
        for unit in UNITS:
            (self.layout.units/unit).unlink()
        with patch.object(installer,'status_probe',return_value=(False,'injected')):
            self.assertEqual(installer.install(True),5)
        self.assertFalse(self.layout.libexec.exists())
        self.assertFalse(self.layout.extension.exists())
        self.assertFalse(any((self.layout.units/u).exists() for u in UNITS))
        self.assertEqual((self.layout.units/'unrelated.timer').read_text(),'unrelated-before')


if __name__=='__main__':
    unittest.main()
