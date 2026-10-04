"""Named-profile persistence/OCC and real CLI validation regression."""
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from icon_normalizer.errors import ProtocolError
from icon_normalizer.profiles import ProfilesStore, validate_name, validate_parameters
from harness import Sandbox

PARAMS = {'target': .83, 'deadband': .02, 'inner': .70}

class Profiles(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(); self.addCleanup(self.box.close)
        self.store = ProfilesStore(self.box.state)

    def save(self, name='My profile', **extras):
        return self.store.save({'name': name, 'parameters': PARAMS,
            'expected_profiles_revision': self.store.catalog()['profiles_revision'], **extras})

    def test_empty_catalog_does_not_create_file(self):
        self.assertEqual(self.store.catalog()['profiles'], [])
        self.assertFalse(self.store.path.exists())

    def test_create_rename_update_delete_and_policy_unchanged(self):
        before = self.box.config_path.read_bytes()
        result = self.save('  我的方案  '); profile = result['profiles'][0]
        self.assertEqual(profile['name'], '我的方案')
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        result = self.save('Rules', profile_id=profile['id'])
        self.assertEqual(result['profiles'][0]['parameters'], PARAMS)
        result = self.store.delete({'profile_id': profile['id'],
            'expected_profiles_revision': result['profiles_revision']})
        self.assertEqual(result['profiles'], [])
        self.assertEqual(before, self.box.config_path.read_bytes())
        self.assertFalse((self.box.state / 'manifest.json').exists())

    def test_second_window_cannot_clobber_stale_catalog(self):
        revision = self.store.catalog()['profiles_revision']; self.save()
        before = self.store.path.read_bytes()
        with self.assertRaises(ProtocolError) as error:
            self.store.save({'name': 'Second', 'parameters': PARAMS,
                'expected_profiles_revision': revision})
        self.assertEqual(error.exception.code, 'REVISION_CONFLICT')
        self.assertEqual(before, self.store.path.read_bytes())

    def test_unicode_normalization_and_casefold_duplicates(self):
        self.save('Café')
        for name in ['Cafe\u0301', 'CAFÉ']:
            with self.subTest(name=name), self.assertRaises(ProtocolError) as error:
                self.save(name)
            self.assertEqual(error.exception.details['reason'], 'PROFILE_NAME_EXISTS')

    def test_invalid_names_and_numeric_combinations(self):
        for name in ['', ' ' * 4, 'a' * 65, 'a\x00b', 'a\u202eb']:
            with self.subTest(name=repr(name)), self.assertRaises(ProtocolError):
                validate_name(name)
        for params in [dict(PARAMS, target=True), dict(PARAMS, target=float('nan')),
                       dict(PARAMS, deadband=.10, target=.98), dict(PARAMS, theme='other')]:
            with self.subTest(params=params), self.assertRaises(ProtocolError):
                validate_parameters(params)

    def test_profile_limit_and_update_at_limit(self):
        for number in range(50): self.save(f'Profile {number}')
        with self.assertRaises(ProtocolError) as error: self.save('One too many')
        self.assertEqual(error.exception.details['reason'], 'PROFILE_LIMIT')
        self.save('Renamed', profile_id=self.store.catalog()['profiles'][0]['id'])
        self.assertEqual(len(self.store.catalog()['profiles']), 50)

    def test_noop_keeps_file_bytes_and_mtime(self):
        profile = self.save()['profiles'][0]
        before = self.store.path.read_bytes(), self.store.path.stat().st_mtime_ns
        self.save(profile['name'], profile_id=profile['id'])
        self.assertEqual(before, (self.store.path.read_bytes(), self.store.path.stat().st_mtime_ns))

    def test_missing_profile_and_corrupt_catalog_refused(self):
        with self.assertRaises(ProtocolError) as error: self.save(profile_id='a' * 32)
        self.assertEqual(error.exception.code, 'NOT_FOUND')
        self.store.path.write_text('{broken')
        with self.assertRaises(ProtocolError): self.store.catalog()

    def test_symlink_never_read_or_written(self):
        victim = self.box.root / 'outside.json'; victim.write_text('untouched')
        self.store.path.symlink_to(victim)
        with self.assertRaises(ProtocolError) as error: self.store.catalog()
        self.assertEqual(error.exception.code, 'OWNERSHIP_CONFLICT')
        self.assertEqual(victim.read_text(), 'untouched')

    def test_real_cli_roundtrip_and_separate_revisions(self):
        rc, catalog = self.box.call_cli('profiles.list'); self.assertEqual(rc, 0)
        _, policy = self.box.call_cli('status')
        rc, result = self.box.call_cli('profiles.save', {'name': 'CLI', 'parameters': PARAMS,
            'expected_profiles_revision': catalog['result']['profiles_revision']})
        self.assertEqual(rc, 0, result)
        _, after = self.box.call_cli('status')
        self.assertEqual(policy['result']['revision'], after['result']['revision'])
        rc, deleted = self.box.call_cli('profiles.delete', {
            'profile_id': result['result']['profiles'][0]['id'],
            'expected_profiles_revision': result['result']['profiles_revision']})
        self.assertEqual((rc, deleted['result']['profiles']), (0, []))

    def test_invalid_merged_preview_refused_before_cache_write(self):
        self.box.write_config(target=.94, deadband=.05, inner=.70)
        rc, response = self.box.call_cli('preview', {'icon_id': 'a'*64, 'source_sha256': 'b'*64,
            'size': 32, 'draft': {'target': .98}})
        self.assertEqual((rc, response['error']['code']), (2, 'INVALID_CONFIG'))
        self.assertFalse(self.box.preview.exists())

    def test_corrupt_config_returns_input_error_instead_of_internal_error(self):
        self.box.config_path.write_text('{"deadband":false}')
        rc, response = self.box.call_cli('scan')
        self.assertEqual((rc, response['error']['code']), (2, 'INVALID_CONFIG'))
        import jsonschema
        _, status = self.box.call_cli('status')
        schema = json.loads((Path(__file__).resolve().parents[2]/'contracts/status-result.schema.json').read_text())
        jsonschema.validate(status['result'], schema)

    def test_new_operations_match_published_schemas(self):
        import jsonschema
        contract_root = Path(__file__).resolve().parents[2] / 'contracts'
        request_schema = json.loads((contract_root/'request.schema.json').read_text())
        response_schema = json.loads((contract_root/'response.schema.json').read_text())
        _, catalog = self.box.call_cli('profiles.list')
        arguments = {'name': 'Contract', 'parameters': PARAMS,
                     'expected_profiles_revision': catalog['result']['profiles_revision']}
        for operation, args in [('profiles.list', {}), ('profiles.save', arguments),
                                ('theme.follow', {'enabled': False}), ('theme.sync', {})]:
            request = {'api_version':1, 'request_id':'test', 'operation':operation, 'arguments':args}
            jsonschema.validate(request, request_schema)
            rc, envelope = self.box.call_cli(operation, args)
            self.assertEqual(rc, 0, envelope); jsonschema.validate(envelope, response_schema)
        _, state = self.box.call_cli('status')
        jsonschema.validate(state['result'], json.loads((contract_root/'status-result.schema.json').read_text()))

    def test_partial_configure_uses_saved_cross_field_values(self):
        self.box.write_config(target=.94, deadband=.01, inner=.70)
        _, before = self.box.call_cli('status')
        rc, valid = self.box.call_cli('configure', {'expected_revision': before['result']['revision'],
            'patch': {'deadband': .05}})
        self.assertEqual(rc, 0, valid)
        rc, invalid = self.box.call_cli('configure', {'expected_revision': valid['result']['revision'],
            'patch': {'target': .98}})
        self.assertEqual((rc, invalid['error']['code']), (2, 'INVALID_CONFIG'))
        self.assertFalse((self.box.state / 'last-error.json').exists())

if __name__ == '__main__': unittest.main()
