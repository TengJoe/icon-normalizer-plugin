"""Reliability regressions against real CLI/engine in a private HOME."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from harness import Sandbox, make_desktop, BACKEND_DIR
sys.path.insert(0, str(BACKEND_DIR))
from icon_normalizer import control, health, dependencies
from icon_normalizer.errors import ProtocolError
from icon_normalizer.policy import sha_hex, canonical_json
from icon_normalizer.fingerprints import policy_fingerprint


class Reliability(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon('fixture-reliable', 200)
        make_desktop(self.box.system_apps/'one.desktop', 'Reliable', 'fixture-reliable')

    def call(self, op, args=None):
        rc, response = self.box.call_cli(op, args)
        self.assertEqual(rc, 0, response)
        return response['result']

    def apply(self):
        return self.call('apply', {'expected_revision':self.call('status')['revision'], 'activate':False})

    def fault(self, code='IO_ERROR', operation='apply'):
        return ProtocolError(code, 'fixture failure', operation=operation)

    def missing(self, dependency, operation, arguments=None):
        code = '''import sys,importlib.abc,runpy
dependency=sys.argv[1]
class Missing(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname==dependency or fullname.startswith(dependency+'.'):
            raise ModuleNotFoundError("No module named '"+fullname+"'",name=fullname)
sys.meta_path.insert(0,Missing())
scheduled=sys.argv[2]=='scheduled';sys.argv=['icon-normalizer','--scheduled' if scheduled else '--json']
runpy.run_module('icon_normalizer',run_name='__main__')
'''
        request={'api_version':1,'request_id':'missing','operation':operation,'arguments':arguments or {}}
        p=subprocess.run([sys.executable,'-B','-c',code,dependency,operation],input=json.dumps(request),
                         capture_output=True,text=True,env=self.box.env(),timeout=20)
        return p, json.loads(p.stdout) if p.stdout.strip() else None

    def test_status_and_doctor_survive_missing_image_dependencies(self):
        for dependency in ('PIL','numpy','gi'):
            for operation in ('status','doctor'):
                with self.subTest(dependency=dependency, operation=operation):
                    p, response=self.missing(dependency,operation)
                    self.assertEqual(p.returncode,0,p.stderr)
                    self.assertTrue(response['ok'])
                    if operation=='status':
                        self.assertEqual(response['result']['last_error']['code'],'DEPENDENCY_MISSING')
                    else:
                        self.assertFalse(response['result']['ok_all'])

    def test_apply_and_scheduled_emit_dependency_failure_and_record_health(self):
        self.call('automation.set',{'enabled':True})
        revision=self.call('status')['revision']
        for dependency in ('PIL','numpy','gi'):
            with self.subTest(dependency=dependency):
                p, response=self.missing(dependency,'apply',{'expected_revision':revision,'activate':False})
                self.assertEqual(p.returncode,4,p.stderr)
                self.assertEqual(response['error']['code'],'DEPENDENCY_MISSING')
                self.assertEqual(response['error']['details']['module'],dependency)
                self.assertNotIn('Traceback',p.stderr)
                p, status=self.missing(dependency,'status')
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertIn('first_seen_unix',status['result']['last_error'])
                p, response=self.missing(dependency,'scheduled')
                self.assertEqual(p.returncode,4,p.stderr)
                self.assertIsNone(response)
                self.assertEqual(self.call('status')['last_error']['code'],'DEPENDENCY_MISSING')

    def test_preview_dependency_failure_is_structured(self):
        group=self.call('scan')['groups'][0]
        p, response=self.missing('PIL','preview',{'icon_id':group['icon_id'],
            'source_sha256':group['source_sha256'],'size':64})
        self.assertEqual(p.returncode,4,p.stderr+str(response))
        self.assertEqual(response['error']['code'],'DEPENDENCY_MISSING')

    def test_control_import_does_not_load_image_modules(self):
        p=subprocess.run([sys.executable,'-B','-c',
            'import sys;import icon_normalizer.control;assert not any(m in sys.modules for m in ("PIL","numpy","icon_normalizer.preview","icon_normalizer.core.engine"))'],
            capture_output=True,text=True,env=self.box.env(),timeout=10)
        self.assertEqual(p.returncode,0,p.stderr)

    def test_unrelated_module_failure_is_not_misclassified(self):
        real=dependencies.importlib.import_module
        def injected(name):
            if name=='numpy': raise ModuleNotFoundError('internal bug',name='unexpected_internal')
            return real(name)
        with patch.object(dependencies.importlib,'import_module',side_effect=injected),self.assertRaises(ModuleNotFoundError):
            dependencies.require_image_runtime()

    def test_fingerprint_remains_byte_identical(self):
        from icon_normalizer.config_store import ConfigStore
        policy=ConfigStore(self.box.state).load_policy()
        core=BACKEND_DIR/'icon_normalizer/core'
        expected=sha_hex((canonical_json(policy.strategy_dict())+sha_hex((core/'analyzer.py').read_bytes())+
                          sha_hex((core/'renderer.py').read_bytes())).encode())
        self.assertEqual(policy_fingerprint(policy),expected)

    def test_conflicts_are_aggregated_and_outputs_preserved(self):
        self.apply()
        targets=sorted(self.box.theme.rglob('*.png'))[:2]
        before_manifest=(self.box.state/'manifest.json').read_bytes()
        for p in targets:p.write_bytes(b'external fixture change')
        before={p:p.read_bytes() for p in self.box.theme.rglob('*') if p.is_file()}
        revision=self.call('status')['revision']
        rc, response=self.box.call_cli('apply',{'expected_revision':revision,'activate':False})
        self.assertEqual(rc,5,response)
        self.assertEqual(response['error']['code'],'OWNERSHIP_CONFLICT')
        details=response['error']['details']
        self.assertEqual(details['conflict_count'],2)
        self.assertEqual({d['path'] for d in details['conflicts']},{str(p) for p in targets})
        for row in details['conflicts']:
            self.assertNotEqual(row['expected_sha256'],row['actual_sha256'])
        self.assertEqual(before_manifest,(self.box.state/'manifest.json').read_bytes())
        self.assertEqual(before,{p:p.read_bytes() for p in self.box.theme.rglob('*') if p.is_file()})
        rc, response=self.box.call_cli('revert')
        self.assertEqual((rc,response['error']['code']),(5,'OWNERSHIP_CONFLICT'))
        self.assertEqual(response['error']['details']['conflict_count'],2)

    def test_unrelated_requests_do_not_clear_maintenance_failure(self):
        self.apply()
        health.record_error(self.box.state,self.fault())
        receipt=(self.box.state/'last-error.json').read_bytes()
        revision=self.call('status')['revision']
        rc, response=self.box.call_cli('configure',{'expected_revision':'f'*64,'patch':{'target':.88}})
        self.assertEqual(rc,3,response)
        self.call('configure',{'expected_revision':revision,'patch':{'target':.88}})
        self.call('automation.set',{'enabled':True})
        self.call('scan')
        self.assertEqual(receipt,(self.box.state/'last-error.json').read_bytes())

    def test_first_seen_and_count_survive_repeated_failure(self):
        with patch.object(health.time,'time',return_value=100):health.record_error(self.box.state,self.fault())
        with patch.object(health.time,'time',return_value=200):health.record_error(self.box.state,self.fault())
        result=self.call('status')['last_error']
        self.assertEqual((result['first_seen_unix'],result['last_seen_unix'],result['count']),(100,200,2))
        history=json.loads((self.box.state/'health-events.json').read_text())
        self.assertEqual([e['kind'] for e in history],['failed'])

    def test_success_resolves_only_its_category(self):
        health.record_error(self.box.state,self.fault())
        health.record_error(self.box.state,self.fault('AUTOMATION_FAILED','automation.set'))
        self.apply()
        self.assertEqual(self.call('status')['last_error']['code'],'AUTOMATION_FAILED')
        self.call('automation.set',{'enabled':True})
        self.assertIsNone(self.call('status')['last_error'])
        history=json.loads((self.box.state/'health-events.json').read_text())
        self.assertEqual(sum(e['kind']=='recovered' for e in history),2)

    def test_event_history_is_bounded_and_private(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for n in range(health.EVENT_LIMIT+4):
                health.record_error(self.box.state,ProtocolError('IO_ERROR',str(n),operation='apply'))
        history=json.loads((self.box.state/'health-events.json').read_text())
        self.assertEqual(len(history),health.EVENT_LIMIT)
        for name in ('last-error.json','health-events.json','health.lock'):
            self.assertEqual((self.box.state/name).stat().st_mode & 0o777,0o600)

    def test_parallel_faults_do_not_lose_counts(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _:health.record_error(self.box.state,self.fault()),range(20)))
        self.assertEqual(self.call('status')['last_error']['count'],20)

    def test_legacy_fault_is_kept_until_a_successful_apply(self):
        (self.box.state/'last-error.json').write_text(json.dumps({'code':'IO_ERROR','message':'legacy','at_unix':50}))
        self.assertEqual(self.call('status')['last_error']['message'],'legacy')
        self.call('configure',{'expected_revision':self.call('status')['revision'],'patch':{'target':.88}})
        self.assertTrue((self.box.state/'last-error.json').exists())
        self.apply()
        self.assertIsNone(self.call('status')['last_error'])

    def test_noop_updates_check_time_but_not_update_time(self):
        self.apply()
        first=self.call('status')
        self.assertIsNotNone(first['last_apply_at'])
        result=self.apply()
        second=self.call('status')
        self.assertEqual(result['file_operations'],0)
        self.assertEqual(first['last_apply_at'],second['last_apply_at'])
        self.assertNotEqual(first['last_check_at'],second['last_check_at'])

    def test_corrupt_health_receipt_does_not_report_healthy(self):
        (self.box.state/'last-error.json').write_text('{broken')
        error=self.call('status')['last_error']
        self.assertEqual(error['code'],'IO_ERROR')
        self.assertEqual(error['details']['reason'],'invalid_health_receipt')

    def test_legacy_metadata_write_does_not_invent_output_update_time(self):
        (self.box.state/'last-run.json').write_text(json.dumps({'checked_at_unix':100,'file_operations':1}))
        status=self.call('status')
        self.assertIsNone(status['last_apply_at'])
        self.assertIsNotNone(status['last_check_at'])

    def test_successful_noop_theme_sync_cannot_clear_failure(self):
        self.apply()
        self.call('automation.set',{'enabled':True})
        health.record_error(self.box.state,self.fault())
        with patch.dict(os.environ,self.box.env(),clear=True),patch.object(control,'_apply_current',return_value={'changed':False}),\
             patch.object(control.service_control,'units_status',return_value={'automatic':'on'}):
            from icon_normalizer.xdg import from_environment
            from icon_normalizer.config_store import ConfigStore
            paths=from_environment();store=ConfigStore(paths.state_dir)
            ctx=control.OperationContext(paths,store,store.load_policy(),store.revision(),False)
            self.assertFalse(control.op_theme_sync({},ctx)['changed'])
        self.assertIsNotNone(self.call('status')['last_error'])

    def test_failure_is_recorded_before_sync_lock_is_released(self):
        from icon_normalizer.xdg import from_environment
        with patch.dict(os.environ,self.box.env(),clear=True):
            paths=from_environment()
            seen=[]
            def record(paths,error):seen.append(control._busy_probe(paths))
            with patch.object(control,'_record_error',side_effect=record),contextlib.redirect_stdout(io.StringIO()):
                rc=control.handle(json.dumps({'api_version':1,'request_id':'lock','operation':'apply',
                    'arguments':{'expected_revision':'a'*64,'activate':False}}).encode(),False,paths)
            self.assertEqual(rc,3)
            self.assertEqual(seen,[True])


if __name__=='__main__':unittest.main()
