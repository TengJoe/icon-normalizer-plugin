"""Late, non-cooperating writers must not become trusted output or be lost."""
from pathlib import Path
from unittest.mock import patch
import io
import json
import os
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from PIL import Image
from harness import Sandbox, make_desktop
from icon_normalizer.errors import ProtocolError
from icon_normalizer.core.transaction import ProtectedRoot, TransactionStore, sha_hex


class OwnershipRaces(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        env = patch.dict(os.environ, self.box.env())
        env.start(); self.addCleanup(env.stop)
        self.box.base_icon('fixture-race', 200)
        self.launcher = self.box.system_apps / 'one.desktop'
        make_desktop(self.launcher, 'Race Fixture', 'fixture-race')
        self.box.build_engine().sync(True)
        self.manifest = self.box.state / 'manifest.json'
        self.before = self.manifest.read_bytes()
        record = json.loads(self.before)['items']['fixture-race']
        self.target = Path(next(iter(record['files'])))
        data = io.BytesIO()
        Image.new('RGBA', (16, 16), (0, 255, 0, 255)).save(data, format='PNG')
        self.external = data.getvalue()
        self.last_run = (self.box.state / 'last-run.json').read_bytes()

    def assert_refused(self, operation, target=None, deleted=False):
        target = target or self.target
        with self.assertRaises(ProtocolError) as raised:
            operation()
        self.assertEqual(raised.exception.code, 'OWNERSHIP_CONFLICT')
        self.assertIn(str(target), [r['path'] for r in raised.exception.details['conflicts']])
        if deleted:
            self.assertFalse(target.exists())
        else:
            self.assertEqual(target.read_bytes(), self.external)
        self.assertEqual(self.manifest.read_bytes(), self.before)
        self.assertEqual((self.box.state / 'last-run.json').read_bytes(), self.last_run)
        self.assertFalse((self.box.state / 'pending.json').exists())

    def materialization_race(self, rerender=False, deleted=False):
        if rerender:
            self.box.write_config(target=.83)
        engine = self.box.build_engine()
        native = engine._materialize
        def race(*args, **kwargs):
            if deleted:
                self.target.unlink()
            else:
                self.target.write_bytes(self.external)
            return native(*args, **kwargs)
        with patch.object(engine, '_materialize', side_effect=race):
            self.assert_refused(lambda: engine.sync(True), deleted=deleted)

    def test_reuse_rejects_external_png_without_adopting_hash(self):
        self.materialization_race()

    def test_rerender_rejects_external_png_without_overwriting_it(self):
        self.materialization_race(rerender=True)

    def test_deletion_after_preflight_is_not_silently_recreated(self):
        self.materialization_race(deleted=True)

    def test_reused_output_is_guarded_even_without_a_write(self):
        engine = self.box.build_engine()
        native = engine.store.commit
        def race(*args, **kwargs):
            self.target.write_bytes(self.external)
            return native(*args, **kwargs)
        with patch.object(engine.store, 'commit', side_effect=race):
            self.assert_refused(lambda: engine.sync(True))

    def test_new_output_collision_after_preflight_is_refused(self):
        self.box.base_icon('fixture-new', 200)
        make_desktop(self.box.system_apps / 'new.desktop', 'New', 'fixture-new')
        target = self.box.theme / '16x16/apps/fixture-new.png'
        engine = self.box.build_engine()
        native = engine._materialize
        def race(*args, **kwargs):
            target.write_bytes(self.external)
            return native(*args, **kwargs)
        with patch.object(engine, '_materialize', side_effect=race):
            self.assert_refused(lambda: engine.sync(True), target=target)

    def test_stale_cleanup_does_not_delete_a_late_external_edit(self):
        self.launcher.unlink()
        engine = self.box.build_engine()
        native = engine.store.commit
        def race(*args, **kwargs):
            self.target.write_bytes(self.external)
            return native(*args, **kwargs)
        with patch.object(engine.store, 'commit', side_effect=race):
            self.assert_refused(lambda: engine.sync(True))

    def test_revert_refuses_late_edit_without_removing_other_outputs(self):
        engine = self.box.build_engine()
        native = engine.store.commit
        other = {p: p.read_bytes() for p in self.box.theme.rglob('*.png') if p != self.target}
        def race(*args, **kwargs):
            self.target.write_bytes(self.external)
            return native(*args, **kwargs)
        with patch.object(engine.store, 'commit', side_effect=race):
            self.assert_refused(engine.revert)
        self.assertTrue(all(p.read_bytes() == data for p, data in other.items()))

    def test_unchanged_apply_remains_zero_operation(self):
        result = self.box.build_engine().sync(True)
        self.assertEqual(result['file_operations'], 0)
        self.assertEqual(self.manifest.read_bytes(), self.before)


class TransactionRaces(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(); self.addCleanup(self.box.close)
        self.root = self.box.theme; self.root.mkdir(parents=True)
        self.a, self.b = self.root / 'a', self.root / 'b'
        self.a.write_bytes(b'old-a'); self.b.write_bytes(b'old-b')
        self.store = TransactionStore(self.box.state / 'pending.json',
                                      [ProtectedRoot(self.root, 0o644)])
        self.guards = {self.a: sha_hex(b'old-a'), self.b: sha_hex(b'old-b')}

    def test_guard_detects_collision_where_absence_was_expected(self):
        self.b.write_bytes(b'external')
        with self.assertRaises(ProtocolError):
            self.store.commit({self.a: b'new-a', self.b: b'new-b'},
                              expected_before={self.a: self.guards[self.a], self.b: None})
        self.assertEqual(self.a.read_bytes(), b'old-a')
        self.assertEqual(self.b.read_bytes(), b'external')
        self.assertFalse(self.store.journal_path.exists())

    def test_edit_during_journal_creation_is_preserved(self):
        from icon_normalizer.core import transaction
        native = transaction.atomic_write
        def race(path, data, mode=0o644):
            native(path, data, mode)
            if path == self.store.journal_path:
                self.b.write_bytes(b'external')
        with patch.object(transaction, 'atomic_write', side_effect=race), self.assertRaises(ProtocolError):
            self.store.commit({self.a: b'new-a', self.b: b'new-b'}, expected_before=self.guards)
        self.assertEqual(self.a.read_bytes(), b'old-a')
        self.assertEqual(self.b.read_bytes(), b'external')
        self.assertFalse(self.store.journal_path.exists())

    def test_late_edit_rolls_back_only_attempted_writes(self):
        from icon_normalizer.core import transaction
        native = transaction.atomic_write
        def race(path, data, mode=0o644):
            native(path, data, mode)
            if path == self.a and data == b'new-a':
                self.b.write_bytes(b'external')
        with patch.object(transaction, 'atomic_write', side_effect=race), self.assertRaises(ProtocolError):
            self.store.commit({self.a: b'new-a', self.b: b'new-b'}, expected_before=self.guards)
        self.assertEqual(self.a.read_bytes(), b'old-a')
        self.assertEqual(self.b.read_bytes(), b'external')
        self.assertFalse(self.store.journal_path.exists())

    def test_unchanged_output_is_rechecked_before_finalization(self):
        from icon_normalizer.core import transaction
        native = transaction.atomic_write
        def race(path, data, mode=0o644):
            native(path, data, mode)
            if path == self.a and data == b'new-a':
                self.b.write_bytes(b'external')
        with patch.object(transaction, 'atomic_write', side_effect=race), self.assertRaises(ProtocolError):
            self.store.commit({self.a: b'new-a'}, expected_before=self.guards)
        self.assertEqual(self.a.read_bytes(), b'old-a')
        self.assertEqual(self.b.read_bytes(), b'external')
        self.assertFalse(self.store.journal_path.exists())

    def test_external_edit_during_finalization_is_not_reported_successful(self):
        calls = []
        def finalize(changed):
            calls.append(changed)
            if len(calls) == 1:
                self.b.write_bytes(b'external')
        self.store.finalize = finalize
        with self.assertRaises(ProtocolError):
            self.store.commit({self.a: b'new-a'}, expected_before=self.guards)
        self.assertEqual(self.a.read_bytes(), b'old-a')
        self.assertEqual(self.b.read_bytes(), b'external')
        self.assertFalse(self.store.journal_path.exists())


if __name__ == '__main__':
    unittest.main()
