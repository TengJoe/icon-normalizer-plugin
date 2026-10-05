"""Theme, automation and inherited-lock recovery failure regression."""
import base64
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'backend'))
from icon_normalizer import control, gsettings
from icon_normalizer.errors import ProtocolError
from icon_normalizer.xdg import RuntimePaths
from harness import Sandbox, make_desktop, png_hashes


class MemoryTheme:
    def __init__(self, value='FixtureBase', accept=True, readback=True):
        self.value,self.accept,self.readback=value,accept,readback
    def get_string(self,key):
        return self.value
    def set_string(self,key,value):
        if self.accept and self.readback:
            self.value=value
        return self.accept


class RecoverySafety(unittest.TestCase):
    def setUp(self):
        self.box=Sandbox()
        self.addCleanup(self.box.close)
        b=self.box
        self.paths=RuntimePaths(b.home,b.state,b.theme,'DockNormalized',b.apps,b.preview,b.root/'libexec')

    def journal(self,data):
        self.paths.settings_pending_path.write_text(json.dumps(data))

    def test_failed_activation_preserves_journal(self):
        self.journal({'stage':'files_committed','activate_theme':'DockNormalized'})
        with self.assertRaises(RuntimeError):
            gsettings.finish_pending_theme(MemoryTheme(accept=False),self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertTrue(self.paths.settings_pending_path.exists())

    def test_activation_requires_readback(self):
        self.journal({'stage':'files_committed','activate_theme':'DockNormalized'})
        with self.assertRaises(RuntimeError):
            gsettings.finish_pending_theme(MemoryTheme(readback=False),self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertTrue(self.paths.settings_pending_path.exists())

    def test_activation_success_removes_journal(self):
        self.journal({'stage':'files_committed','activate_theme':'DockNormalized'})
        setting=MemoryTheme()
        gsettings.finish_pending_theme(setting,self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertEqual(setting.value,'DockNormalized')
        self.assertFalse(self.paths.settings_pending_path.exists())

    def test_gsettings_unavailable_retains_log(self):
        self.journal({'stage':'files_committed','activate_theme':'DockNormalized'})
        with self.assertRaises(RuntimeError):
            gsettings.finish_pending_theme(None,self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertTrue(self.paths.settings_pending_path.exists())

    def test_unknown_stage_preserves_log(self):
        self.journal({'stage':'unknown'})
        with self.assertRaises(RuntimeError):
            gsettings.finish_pending_theme(MemoryTheme(),self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertTrue(self.paths.settings_pending_path.exists())

    def test_prepared_revert_recovers_both_manifest_generations(self):
        before,after=b'old-generation',b'new-generation'
        for data,want in [(before,'DockNormalized'),(after,'FixtureBase')]:
            with self.subTest(generation=data):
                self.paths.manifest_path.write_bytes(data)
                self.journal({'stage':'revert_prepared','previous_theme':'DockNormalized',
                              'restore_theme':'FixtureBase','manifest_before_sha':hashlib.sha256(before).hexdigest(),
                              'manifest_after_sha':hashlib.sha256(after).hexdigest()})
                setting=MemoryTheme('unexpected')
                gsettings.finish_pending_theme(setting,self.paths.settings_pending_path,self.paths.manifest_path)
                self.assertEqual(setting.value,want)

    def test_external_manifest_edit_prevents_guessing(self):
        self.paths.manifest_path.write_bytes(b'external-edit')
        self.journal({'stage':'revert_prepared','previous_theme':'DockNormalized','restore_theme':'FixtureBase',
                      'manifest_before_sha':'a'*64,'manifest_after_sha':'b'*64})
        with self.assertRaises(RuntimeError):
            gsettings.finish_pending_theme(MemoryTheme(),self.paths.settings_pending_path,self.paths.manifest_path)
        self.assertTrue(self.paths.settings_pending_path.exists())

    def test_cache_failure_restores_theme_and_file_generation(self):
        self.box.base_icon('fixture-safety',200)
        make_desktop(self.box.system_apps/'one.desktop','One','fixture-safety')
        setting=MemoryTheme()
        engine=self.box.build_engine(settings=setting)
        engine.sync(True,activate=True)
        files=png_hashes(self.box.theme)
        manifest=self.paths.manifest_path.read_bytes()
        native=engine.rebuild_cache
        count=[]
        def fail_once():
            count.append(1)
            if len(count)==1:
                raise RuntimeError('injected cache failure')
            native()
        with patch.object(engine,'rebuild_cache',side_effect=fail_once),self.assertRaises(RuntimeError):
            engine.revert()
        self.assertEqual(setting.value,'DockNormalized')
        self.assertEqual(png_hashes(self.box.theme),files)
        self.assertEqual(self.paths.manifest_path.read_bytes(),manifest)
        self.assertFalse(self.paths.settings_pending_path.exists())

    def test_automation_stop_failure_prevents_file_revert(self):
        state={name:{'enabled':True,'active':True} for name in ('timer','path')}
        engine=Mock()
        engine.revert_manifest_bytes.return_value=b'after'
        ctx=SimpleNamespace(store=None,policy=None,paths=self.paths)
        with patch.object(control,'_build_engine',return_value=engine),\
             patch.object(control.service_control,'units_status',return_value=state),\
             patch.object(control.service_control,'set_enabled',return_value={'ok':False,'units':state}),\
             patch.object(control.service_control,'restore_units',return_value={'ok':True,'units':state}),\
             self.assertRaises(ProtocolError) as error:
            control.op_revert({},ctx)
        self.assertEqual(error.exception.code,'AUTOMATION_FAILED')
        engine.revert.assert_not_called()
        self.assertFalse(self.paths.revert_pending_path.exists())

    def test_revert_recovery_keeps_journal_when_triggers_fail(self):
        data={'stage':'revert_prepared','units_before':{},'manifest_before_sha':None,
              'manifest_after_sha':hashlib.sha256(b'after').hexdigest()}
        self.paths.manifest_path.write_bytes(b'after')
        self.paths.revert_pending_path.write_text(json.dumps(data))
        with patch.object(control.service_control,'set_enabled',return_value={'ok':False,'units':{}}),\
             self.assertRaises(ProtocolError):
            control._finish_revert_commit(self.paths)
        self.assertTrue(self.paths.revert_pending_path.exists())

    def test_inherited_lock_keeps_parent_exclusion_after_child_close(self):
        with open(self.paths.lock_path,'a') as parent:
            fcntl.flock(parent,fcntl.LOCK_EX)
            with patch.dict(os.environ,{'ICON_NORMALIZER_LOCK_FD':str(parent.fileno())}):
                child=control._acquire(self.paths,0)
                child.close()
            with open(self.paths.lock_path,'a') as contender,self.assertRaises(BlockingIOError):
                fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def test_inherited_wrong_inode_is_rejected(self):
        self.paths.lock_path.touch()
        with open(self.box.root/'other.lock','a') as wrong,\
             patch.dict(os.environ,{'ICON_NORMALIZER_LOCK_FD':str(wrong.fileno())}),\
             self.assertRaises(RuntimeError):
            control._acquire(self.paths,0)

    def test_automation_failure_restores_partial_states_exactly(self):
        from icon_normalizer import service_control as service
        states={'icon-normalizer.timer':{'enabled':True,'active':False},
                'icon-normalizer.path':{'enabled':False,'active':True}}
        original=json.loads(json.dumps(states))
        failed=[]
        def manager(args,**kwargs):
            unit=next((a for a in args if a in states),None)
            if args[0]=='show':
                s=states[unit]
                return 0,'UnitFileState='+('enabled' if s['enabled'] else 'disabled')+'\nActiveState='+('active' if s['active'] else 'inactive')+'\n',''
            if args[0]=='enable' and unit=='icon-normalizer.path' and not failed:
                failed.append(1)
                return 1,'','injected'
            s=states[unit]
            if args[0] in ('enable','disable'):
                s['enabled']=args[0]=='enable'
                if '--now' in args:
                    s['active']=args[0]=='enable'
            else:
                s['active']=args[0]=='start'
            return 0,'',''
        with patch.object(service,'_systemctl',side_effect=manager):
            result=service.set_enabled(True)
        self.assertFalse(result['ok'])
        self.assertTrue(result['restored'])
        self.assertEqual(states,original)

    def test_queued_worker_does_not_reapply_after_revert(self):
        engine=Mock()
        with patch.object(control.service_control,'units_status',return_value={'automatic':'off'}),\
             patch.object(control,'_build_engine',return_value=engine):
            self.assertEqual(control._run_scheduled(self.paths),0)
        engine.sync.assert_not_called()

    def test_crashed_revert_recovers_files_before_compensating_theme(self):
        self.box.base_icon('fixture-crash',200)
        make_desktop(self.box.system_apps/'one.desktop','One','fixture-crash')
        setting=MemoryTheme()
        engine=self.box.build_engine(settings=setting)
        engine.sync(True,activate=True)
        files=png_hashes(self.box.theme)
        target=next(self.box.theme.rglob('*.png'))
        original=target.read_bytes()
        digest=hashlib.sha256(self.paths.manifest_path.read_bytes()).hexdigest()
        self.journal({'stage':'revert_prepared','previous_theme':'DockNormalized',
                      'restore_theme':'FixtureBase','manifest_before_sha':digest,
                      'manifest_after_sha':hashlib.sha256(engine.revert_manifest_bytes()).hexdigest()})
        setting.value='FixtureBase'
        self.paths.pending_path.write_text(json.dumps({'ops':[{
            'path':str(target),'before':base64.b64encode(original).decode(),
            'before_sha':hashlib.sha256(original).hexdigest(),'after_sha':None,'before_mode':0o644}]}))
        target.unlink()
        ctx=SimpleNamespace(paths=self.paths,store=None,policy=None)
        with patch.object(control,'_build_engine',return_value=engine),\
             patch.object(control,'load_interface_settings',return_value=setting):
            control._recover_transactions(ctx)
        self.assertEqual(png_hashes(self.box.theme),files)
        self.assertEqual(setting.value,'DockNormalized')
        self.assertFalse(self.paths.pending_path.exists())
        self.assertFalse(self.paths.settings_pending_path.exists())

    def test_worker_rechecks_launchers_changed_during_apply(self):
        engine=Mock()
        with patch.object(control.service_control,'units_status',return_value={'automatic':'on'}),\
             patch.object(control,'_launcher_stamp',side_effect=[(('first',1,1),),(('changed',2,2),),
                                                                (('changed',2,2),),(('changed',2,2),)]),\
             patch.object(control,'_build_engine',return_value=engine):
            self.assertEqual(control._run_scheduled(self.paths),0)
        self.assertEqual(engine.sync.call_count,2)

    def test_worker_skip_exits_busy_with_a_diagnostic_line(self):
        # A timer/path trigger that loses the lock race to the UI or another
        # worker is a normal skip: report EXIT_BUSY and say why, so the journal
        # explains the run instead of showing a bare non-zero exit.
        captured=io.StringIO()
        with patch.object(control,'_acquire',return_value=None),\
             patch.object(sys,'stderr',captured):
            self.assertEqual(control._run_scheduled(self.paths),control.EXIT_BUSY)
        self.assertIn('sync.lock',captured.getvalue())

    def test_busy_response_does_not_pollute_persistent_health(self):
        control._record_error(self.paths,ProtocolError('BUSY','expected contention'))
        self.assertFalse(self.paths.last_error_path.exists())


if __name__=='__main__':
    unittest.main()
