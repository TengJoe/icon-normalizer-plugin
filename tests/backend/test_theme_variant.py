"""Unit tests for heuristic theme variant resolution across ecosystems."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from icon_normalizer import theme_follow


class TestThemeVariantResolution(unittest.TestCase):
    def test_parse_theme_variant_dark_suffixes(self):
        self.assertEqual(theme_follow.parse_theme_variant("Yaru-blue-dark"), ("Yaru-blue", "-", "dark"))
        self.assertEqual(theme_follow.parse_theme_variant("Humanity-Dark"), ("Humanity", "-", "dark"))
        self.assertEqual(theme_follow.parse_theme_variant("Tela-blue-dark"), ("Tela-blue", "-", "dark"))
        self.assertEqual(theme_follow.parse_theme_variant("Custom_Theme_dark"), ("Custom_Theme", "_", "dark"))
        self.assertEqual(theme_follow.parse_theme_variant("Orchis-black"), ("Orchis", "-", "dark"))

    def test_parse_theme_variant_light_suffixes(self):
        self.assertEqual(theme_follow.parse_theme_variant("Papirus-Light"), ("Papirus", "-", "light"))
        self.assertEqual(theme_follow.parse_theme_variant("WhiteSur-light"), ("WhiteSur", "-", "light"))
        self.assertEqual(theme_follow.parse_theme_variant("Custom_light"), ("Custom", "_", "light"))

    def test_parse_theme_variant_single_theme(self):
        self.assertEqual(theme_follow.parse_theme_variant("Adwaita"), ("Adwaita", None, None))
        self.assertEqual(theme_follow.parse_theme_variant("hicolor"), ("hicolor", None, None))
        self.assertEqual(theme_follow.parse_theme_variant("Nordzy"), ("Nordzy", None, None))

    def test_resolve_variant_with_mock_installed_themes(self):
        installed = {
            # Yaru variants
            "Yaru", "Yaru-dark",
            "Yaru-blue", "Yaru-blue-dark",
            "Yaru-purple", "Yaru-purple-dark",
            # Humanity
            "Humanity", "Humanity-Dark",
            # Papirus
            "Papirus", "Papirus-Dark", "Papirus-Light",
            # Tela
            "Tela", "Tela-dark", "Tela-blue", "Tela-blue-dark",
            # Breeze
            "breeze", "breeze-dark",
            # Single themes
            "Adwaita", "HighContrast", "Nordzy",
        }
        
        is_inst = lambda name: name in installed

        cases = [
            # From dark to light
            ("Yaru-blue-dark", False, "Yaru-blue"),
            ("Yaru-purple-dark", False, "Yaru-purple"),
            ("Yaru-dark", False, "Yaru"),
            ("Humanity-Dark", False, "Humanity"),
            ("Papirus-Dark", False, "Papirus"),
            ("Tela-blue-dark", False, "Tela-blue"),
            ("breeze-dark", False, "breeze"),

            # From light to dark
            ("Yaru-blue", True, "Yaru-blue-dark"),
            ("Yaru-purple", True, "Yaru-purple-dark"),
            ("Yaru", True, "Yaru-dark"),
            ("Humanity", True, "Humanity-Dark"),
            ("Papirus", True, "Papirus-Dark"),
            ("Papirus-Light", True, "Papirus-Dark"),
            ("Tela-blue", True, "Tela-blue-dark"),
            ("breeze", True, "breeze-dark"),

            # Single themes (no matching dark/light variant exists in installed)
            ("Adwaita", True, "Adwaita"),
            ("Adwaita", False, "Adwaita"),
            ("HighContrast", True, "HighContrast"),
            ("Nordzy", True, "Nordzy"),
            ("Nordzy", False, "Nordzy"),

            # Idempotency (already in target state)
            ("Yaru-blue-dark", True, "Yaru-blue-dark"),
            ("Yaru-blue", False, "Yaru-blue"),
            ("Papirus-Dark", True, "Papirus-Dark"),
        ]

        for theme, prefer_dark, expected in cases:
            with self.subTest(theme=theme, prefer_dark=prefer_dark):
                actual = theme_follow.resolve_variant(theme, prefer_dark, [], is_installed_fn=is_inst)
                self.assertEqual(actual, expected)

    def test_current_color_scheme_with_mock_settings(self):
        from icon_normalizer import gsettings

        class MockSettings:
            def __init__(self, scheme: str):
                self.scheme = scheme

            def get_string(self, key: str) -> str:
                if key == "color-scheme":
                    return self.scheme
                return ""

        self.assertEqual(gsettings.current_color_scheme(MockSettings("prefer-dark")), "prefer-dark")
        self.assertEqual(gsettings.current_color_scheme(MockSettings("prefer-light")), "prefer-light")
        self.assertEqual(gsettings.current_color_scheme(MockSettings("default")), "default")


import os
from unittest.mock import patch
from icon_normalizer import control
from icon_normalizer.config_store import ConfigStore, PolicyDefaults
from icon_normalizer.xdg import RuntimePaths
from harness import Sandbox, make_desktop, make_icon, png_hashes, INDEX_THEME


class MockThemeWithScheme:
    def __init__(self, value="DockNormalized", color_scheme="prefer-dark"):
        self.value = value
        self.color_scheme = color_scheme

    def get_string(self, key: str) -> str:
        if key == "icon-theme":
            return self.value
        if key == "color-scheme":
            return self.color_scheme
        return ""

    def set_string(self, key: str, value: str) -> bool:
        if key == "icon-theme":
            self.value = value
        elif key == "color-scheme":
            self.color_scheme = value
        return True


class TestThemeVariantIntegration(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        b = self.box
        b.write_config(target=0.83, inner=0.70)
        b.base_icon("fixture-follow", 200, "red")
        make_desktop(b.system_apps / "one.desktop", "Follow", "fixture-follow")

        # Install both FixtureBlue (light) and FixtureBlue-dark (dark)
        for name, color in [("FixtureBlue", "blue"), ("FixtureBlue-dark", "navy")]:
            root = b.share / "icons" / name
            root.mkdir(parents=True, exist_ok=True)
            (root / "index.theme").write_text(INDEX_THEME.replace("FixtureBase", name))
            make_icon(root / "256x256/apps/fixture-follow.png", 200, color)

        # Initially set base theme to FixtureBlue
        self.setting = MockThemeWithScheme(value="DockNormalized", color_scheme="prefer-dark")
        self.engine = b.build_engine(self.setting)
        self.engine.sync(True, activate=True)
        self.paths = RuntimePaths(b.home, b.state, b.theme, "DockNormalized", b.apps, b.preview, b.root / "libexec")

        self.env = patch.dict(os.environ, b.env())
        self.env.start()
        self.addCleanup(self.env.stop)
        self.settings_patch = patch.object(control, "load_interface_settings", return_value=self.setting)
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.units = patch.object(control.service_control, "units_status", return_value={"automatic": "on"})
        self.units.start()
        self.addCleanup(self.units.stop)

    def context(self):
        store = ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBlue"))
        policy = store.load_policy()
        return control.OperationContext(self.paths, store, policy, store.revision(policy), scheduled=False)

    def test_color_scheme_shift_automatically_migrates_variant(self):
        ctx = self.context()
        self.assertEqual(ctx.policy.base_theme, "FixtureBase")

        # First migrate to FixtureBlue
        self.setting.value = "FixtureBlue"
        res1 = control.op_theme_sync({}, ctx)
        self.assertTrue(res1["changed"])
        self.assertEqual(self.context().policy.base_theme, "FixtureBlue")
        self.assertIn("Inherits=FixtureBlue,hicolor", (self.box.theme / "index.theme").read_text())

        # Now system is in DockNormalized, but color-scheme is prefer-dark!
        # Next sync will detect FixtureBlue -> FixtureBlue-dark variant shift!
        ctx = self.context()
        res2 = control.op_theme_sync({}, ctx)
        self.assertTrue(res2["changed"])
        self.assertEqual(res2["source_theme"], "FixtureBlue-dark")
        self.assertEqual(self.context().policy.base_theme, "FixtureBlue-dark")
        self.assertIn("Inherits=FixtureBlue-dark,hicolor", (self.box.theme / "index.theme").read_text())
        self.assertEqual(self.setting.value, "DockNormalized")

        # Now switch color-scheme to prefer-light!
        self.setting.color_scheme = "prefer-light"
        ctx = self.context()
        res3 = control.op_theme_sync({}, ctx)
        self.assertTrue(res3["changed"])
        self.assertEqual(res3["source_theme"], "FixtureBlue")
        self.assertEqual(self.context().policy.base_theme, "FixtureBlue")
        self.assertIn("Inherits=FixtureBlue,hicolor", (self.box.theme / "index.theme").read_text())
        self.assertEqual(self.setting.value, "DockNormalized")


if __name__ == "__main__":
    unittest.main()
