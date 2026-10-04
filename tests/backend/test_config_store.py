"""ConfigStore: policy migration, rules persistence, atomic writes."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.config_store import ConfigStore  # noqa: E402
from icon_normalizer.policy import Policy, PolicyDefaults  # noqa: E402


class TestConfigStore(unittest.TestCase):
    def _store(self, root: Path) -> ConfigStore:
        return ConfigStore(root / "state", PolicyDefaults(base_theme="FixtureBase"))

    def test_default_policy_created(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            policy = store.load_policy()
            self.assertEqual(policy.target, 0.88)
            self.assertEqual(policy.base_theme, "FixtureBase")
            self.assertEqual(len(policy.sizes), 9)

    def test_config_rejects_boolean_numbers_and_nonstring_theme(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp)); store.state_dir.mkdir()
            for document in [{'deadband': False}, {'inner': '0.70'}, {'schema_version': True},
                             {'base_theme': ['FixtureBase']}]:
                with self.subTest(document=document):
                    store.config_path.write_text(json.dumps(document))
                    with self.assertRaises(ValueError): store.load_policy()

    def test_v1_migration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({
                "schema_version": 1, "target": 0.9, "deadband": 0.02, "inner": 0.7,
            }))
            policy = store.load_policy()
            self.assertEqual(policy.target, 0.9)
            self.assertEqual(policy.inner, 0.7)
            # re-persist migrates to v2
            store.write_policy_if_changed(policy)
            data = json.loads(store.config_path.read_text())
            self.assertEqual(data["schema_version"], 2)

    def test_unsupported_schema_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            store.config_path.write_text(json.dumps({"schema_version": 99}))
            with self.assertRaises(ValueError):
                store.load_policy()

    def test_corrupt_rules_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            store.rules_path.write_text('{"schema_version": 7}')
            with self.assertRaises(ValueError):
                store.load_rules()

    def test_write_if_changed_leaves_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            policy = Policy(base_theme="FixtureBase")
            self.assertTrue(store.write_policy_if_changed(policy))
            first_stat = store.config_path.stat().st_mtime_ns
            self.assertFalse(store.write_policy_if_changed(policy))
            self.assertEqual(store.config_path.stat().st_mtime_ns, first_stat)
            changed = Policy(target=0.9, base_theme="FixtureBase")
            self.assertTrue(store.write_policy_if_changed(changed))

    def test_state_files_are_0600(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            store.write_policy_if_changed(Policy(base_theme="FixtureBase"))
            store.write_rules_if_changed({"schema_version": 1, "icons": {}})
            import os

            self.assertEqual(os.stat(store.config_path).st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(store.rules_path).st_mode & 0o777, 0o600)

    def test_patch_updates_and_validates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            policy = Policy(base_theme="FixtureBase")
            updated = store.apply_patch(policy, {"target": 0.9})
            self.assertEqual(updated.target, 0.9)
            self.assertEqual(policy.target, 0.88)  # immutable
            with self.assertRaises(ValueError):
                store.apply_patch(policy, {"deadband": 0.9})

    def test_revision_covers_policy_and_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(Path(tmp))
            store.state_dir.mkdir(parents=True, exist_ok=True)
            policy = store.load_policy()
            rev_a = store.revision(policy)
            store.write_rules_if_changed({"schema_version": 1, "icons": {"x": {"skip": True}}})
            rev_b = store.revision(policy)
            self.assertNotEqual(rev_a, rev_b)


if __name__ == "__main__":
    unittest.main()
