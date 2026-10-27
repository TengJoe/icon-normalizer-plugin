"""A committed file transaction must never imply a committed theme switch.

Regression for the silent path where apply ran with activate=True but the
desktop kept the previous icon theme while every status and UI reported success.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer import gsettings  # noqa: E402

from harness import Sandbox, make_desktop  # noqa: E402
from test_recovery_safety import MemoryTheme  # noqa: E402


class ActivationReporting(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("fixture-act", 200)
        make_desktop(self.box.system_apps / "act.desktop", "Act", "fixture-act")

    def test_activate_reports_applied_and_switches_theme(self):
        settings = MemoryTheme("FixtureBase")
        payload = self.box.build_engine(settings).sync(True, activate=True)
        self.assertEqual(payload["theme_activation"], "applied")
        self.assertTrue(payload["summary"]["theme_active"])
        self.assertEqual(settings.value, "DockNormalized")

    def test_activate_without_settings_reports_unavailable(self):
        with patch.object(gsettings, "read_icon_theme_cli", return_value="FixtureBase"):
            payload = self.box.build_engine(None).sync(True, activate=True)
        self.assertEqual(payload["theme_activation"], "unavailable")
        self.assertFalse(payload["summary"]["theme_active"])

    def test_apply_without_activation_reports_not_requested(self):
        settings = MemoryTheme("FixtureBase")
        payload = self.box.build_engine(settings).sync(True)
        self.assertEqual(payload["theme_activation"], "not_requested")
        self.assertFalse(payload["summary"]["theme_active"])
        self.assertEqual(settings.value, "FixtureBase")

    def test_late_theme_choice_supersedes_activation(self):
        settings = MemoryTheme("FixtureGreen")
        payload = self.box.build_engine(settings).sync(
            True, activate=True, activate_if_theme="FixtureBlue")
        self.assertEqual(payload["theme_activation"], "superseded")
        self.assertEqual(settings.value, "FixtureGreen")


if __name__ == "__main__":
    unittest.main()
