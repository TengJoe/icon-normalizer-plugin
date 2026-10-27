"""Persistent theme-follow failures stay visible without resetting user data."""
from pathlib import Path
import contextlib
import io
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
import test_theme_follow
from icon_normalizer import control, health, theme_follow
from icon_normalizer.errors import ProtocolError


class PersistedConfigHealth(unittest.TestCase):
    def setUp(self):
        self.fixture = test_theme_follow.ThemeFollow('test_default_mode_read_is_write_free_and_toggle_private')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.box = self.fixture.box
        self.assertEqual(control._run_scheduled(self.fixture.paths), 0)

    def test_corrupt_file_is_visible_before_the_worker_without_writing_health(self):
        for payload in ('{ broken json', '[]', '{"schema_version":1,"enabled":"yes"}'):
            with self.subTest(payload=payload):
                path = self.box.state / 'theme-follow.json'; path.write_text(payload)
                status = control.op_status({}, None)
                self.assertIsNone(status['theme_follow'])
                self.assertEqual(status['last_error']['code'], 'INVALID_CONFIG')
                self.assertEqual(status['last_error']['details']['reason'], 'PERSISTED_CONFIG_INVALID')
                self.assertEqual(path.read_text(), payload)
                self.assertFalse((self.box.state / 'last-error.json').exists())

    def test_failure_counts_survive_status_and_repair_until_successful_maintenance(self):
        path = self.box.state / 'theme-follow.json'; path.write_text('{ broken json')
        before = {p: p.read_bytes() for p in self.box.theme.rglob('*.png')}
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(control._run_scheduled(self.fixture.paths), 2)
            first = control.op_status({}, None)['last_error']
            self.assertEqual(control._run_scheduled(self.fixture.paths), 2)
            repeated = control.op_status({}, None)['last_error']
            self.assertEqual(repeated['count'], 2)
            self.assertEqual(first['first_seen_unix'], repeated['first_seen_unix'])
            theme_follow.set_enabled(self.box.state, True)
            self.assertEqual(control.op_status({}, None)['last_error']['count'], 2)
            self.assertEqual(control._run_scheduled(self.fixture.paths), 0)
        self.assertIsNone(control.op_status({}, None)['last_error'])
        self.assertTrue(all(p.read_bytes() == data for p, data in before.items()))

    def test_rejected_user_config_input_is_not_a_persistent_fault(self):
        health.record_error(self.box.state, ProtocolError('INVALID_CONFIG', 'invalid input', operation='configure'))
        self.assertFalse((self.box.state / 'last-error.json').exists())


if __name__ == '__main__':
    unittest.main()
