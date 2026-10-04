"""Real rendering/transaction/theme-follow regression in disposable homes."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from icon_normalizer import control, theme_follow, gsettings
from icon_normalizer.config_store import ConfigStore, PolicyDefaults
from icon_normalizer.core.engine import Engine
from icon_normalizer.errors import ProtocolError
from icon_normalizer.xdg import RuntimePaths
from harness import Sandbox, make_desktop, make_icon, png_hashes, INDEX_THEME
from test_recovery_safety import MemoryTheme

class ThemeFollow(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox(); self.addCleanup(self.box.close)
        b = self.box; b.write_config(target=.83, inner=.70)
        b.base_icon('fixture-follow', 200, 'red')
        make_desktop(b.system_apps / 'one.desktop', 'Follow', 'fixture-follow')
        for name, color in [('FixtureBlue', 'blue'), ('FixtureGreen', 'green')]:
            root = b.share / 'icons' / name; root.mkdir()
            (root / 'index.theme').write_text(INDEX_THEME.replace('FixtureBase', name))
            make_icon(root / '256x256/apps/fixture-follow.png', 200, color)
        self.setting = MemoryTheme()
        self.engine = b.build_engine(self.setting); self.engine.sync(True, activate=True)
        self.paths = RuntimePaths(b.home, b.state, b.theme, 'DockNormalized', b.apps, b.preview, b.root/'libexec')
        self.env = patch.dict(os.environ, b.env()); self.env.start(); self.addCleanup(self.env.stop)
        self.settings_patch = patch.object(control, 'load_interface_settings', return_value=self.setting)
        self.settings_patch.start(); self.addCleanup(self.settings_patch.stop)
        self.units = patch.object(control.service_control, 'units_status', return_value={'automatic': 'on'})
        self.units.start(); self.addCleanup(self.units.stop)

    def context(self):
        store = ConfigStore(self.box.state, PolicyDefaults(base_theme='FixtureBase'))
        policy = store.load_policy()
        return control.OperationContext(self.paths, store, policy, store.revision(policy), scheduled=False)

    def test_theme_follow_preserves_parameters_and_updates_restore_target(self):
        before = png_hashes(self.box.theme); self.setting.value = 'FixtureBlue'
        ctx = self.context(); result = control.op_theme_sync({}, ctx)
        self.assertTrue(result['changed']); self.assertEqual(self.setting.value, 'DockNormalized')
        policy = ctx.store.load_policy()
        self.assertEqual((policy.target, policy.deadband, policy.inner, policy.base_theme), (.83, .02, .70, 'FixtureBlue'))
        self.assertNotEqual(before, png_hashes(self.box.theme))
        self.assertIn('Inherits=FixtureBlue,hicolor', (self.box.theme/'index.theme').read_text())
        baseline = json.loads(self.paths.baseline_path.read_text())
        self.assertEqual(baseline['icon_theme'], 'FixtureBlue')
        self.assertEqual(self.paths.config_path.stat().st_mode & 0o777, 0o600)
        restored = control._build_engine(ctx.store, policy, self.paths).revert()
        self.assertEqual(restored['restored_theme'], 'FixtureBlue')
        self.assertEqual(self.setting.value, 'FixtureBlue')

    def test_default_mode_read_is_write_free_and_toggle_private(self):
        path = self.box.state/'theme-follow.json'
        self.assertTrue(theme_follow.enabled(self.box.state)); self.assertFalse(path.exists())
        theme_follow.set_enabled(self.box.state, False)
        self.assertFalse(theme_follow.enabled(self.box.state))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_disabled_mode_or_automation_leaves_new_theme_untouched(self):
        self.setting.value = 'FixtureBlue'; before = png_hashes(self.box.theme)
        theme_follow.set_enabled(self.box.state, False)
        self.assertFalse(control.op_theme_sync({}, self.context())['changed'])
        theme_follow.set_enabled(self.box.state, True)
        with patch.object(control.service_control, 'units_status', return_value={'automatic': 'off'}):
            self.assertFalse(control.op_theme_sync({}, self.context())['changed'])
        with patch.object(control.service_control, 'units_status', return_value={'automatic': 'unknown'}):
            self.assertFalse(control.op_theme_sync({}, self.context())['changed'])
        self.assertEqual(before, png_hashes(self.box.theme)); self.assertEqual(self.setting.value, 'FixtureBlue')

    def test_selecting_original_source_does_not_force_reactivation(self):
        self.setting.value = 'FixtureBase'
        self.assertFalse(control.op_theme_sync({}, self.context())['changed'])
        self.assertEqual(self.setting.value, 'FixtureBase')

    def test_nonexistent_or_unsafe_theme_refused_without_policy_changes(self):
        before = self.paths.config_path.read_bytes(), self.paths.baseline_path.read_bytes(), png_hashes(self.box.theme)
        for name in ['MissingTheme', '../FixtureBlue']:
            self.setting.value = name
            with self.subTest(theme=name), self.assertRaises(ProtocolError):
                control.op_theme_sync({}, self.context())
            self.assertEqual(before, (self.paths.config_path.read_bytes(), self.paths.baseline_path.read_bytes(), png_hashes(self.box.theme)))

    def test_cache_failure_rolls_back_icons_config_and_baseline_together(self):
        before = self.paths.config_path.read_bytes(), self.paths.baseline_path.read_bytes(), png_hashes(self.box.theme)
        self.setting.value = 'FixtureBlue'; native = Engine.rebuild_cache; calls = []
        def fail_once(engine):
            calls.append(1)
            if len(calls) == 1: raise RuntimeError('injected migration cache failure')
            return native(engine)
        with patch.object(Engine, 'rebuild_cache', fail_once), self.assertRaises(RuntimeError):
            control.op_theme_sync({}, self.context())
        self.assertEqual(before, (self.paths.config_path.read_bytes(), self.paths.baseline_path.read_bytes(), png_hashes(self.box.theme)))
        self.assertEqual(self.setting.value, 'FixtureBlue')
        self.assertFalse(self.paths.pending_path.exists())

    def test_latest_selection_wins_if_user_changes_during_render(self):
        self.setting.value = 'FixtureBlue'; native = Engine.inspect
        def change_during_render(engine):
            result = native(engine); self.setting.value = 'FixtureGreen'; return result
        with patch.object(Engine, 'inspect', change_during_render):
            control.op_theme_sync({}, self.context())
        self.assertEqual(self.setting.value, 'FixtureGreen')
        self.assertFalse(self.paths.settings_pending_path.exists())
        result = control.op_theme_sync({}, self.context())
        self.assertTrue(result['changed']); self.assertEqual(result['source_theme'], 'FixtureGreen')
        self.assertEqual(self.setting.value, 'DockNormalized')

    def test_recovery_guard_does_not_overwrite_newer_choice(self):
        self.paths.settings_pending_path.write_text(json.dumps({'stage': 'files_committed',
            'activate_theme': 'DockNormalized', 'only_if_current_theme': 'FixtureBlue'}))
        self.setting.value = 'FixtureGreen'
        gsettings.finish_pending_theme(self.setting, self.paths.settings_pending_path, self.paths.manifest_path)
        self.assertEqual(self.setting.value, 'FixtureGreen')
        self.assertFalse(self.paths.settings_pending_path.exists())

    def test_corrupt_restore_baseline_blocks_migration(self):
        self.setting.value = 'FixtureBlue'; self.paths.baseline_path.write_text('{broken')
        with self.assertRaises(ProtocolError) as error:
            control.op_theme_sync({}, self.context())
        self.assertEqual(error.exception.code, 'RECOVERY_REQUIRED')
        self.assertEqual(self.context().policy.base_theme, 'FixtureBase')

    def test_scheduled_worker_follows_without_preferences_or_panel(self):
        self.setting.value = 'FixtureBlue'
        self.assertEqual(control._run_scheduled(self.paths), 0)
        self.assertEqual(self.setting.value, 'DockNormalized')
        self.assertEqual(self.context().policy.base_theme, 'FixtureBlue')

if __name__ == '__main__': unittest.main()
