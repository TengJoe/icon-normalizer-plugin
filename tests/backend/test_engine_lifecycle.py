"""Engine lifecycle regression suite (ports the validated 12-scenario matrix).

Covers: dry-run purity, first apply, idempotency, source updates, new apps,
uninstall cleanup, missing-artwork isolation, absolute-path overrides,
rollback with user-edit preservation, cache-failure rollback, journal
recovery after interruption, and unowned-collision refusal.

A fresh Engine is built per operation, mirroring production: every CLI
invocation constructs its own engine (and therefore its own Gtk.IconTheme
view of the filesystem), so newly written fixture artwork is always visible.
"""
from __future__ import annotations

import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.core.transaction import atomic_write  # noqa: E402
from icon_normalizer.desktop import read_desktop_section  # noqa: E402
from icon_normalizer.policy import sha_hex  # noqa: E402

from harness import Sandbox, make_desktop, make_icon, png_hashes  # noqa: E402


class EngineLifecycle(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        # core fixture: one enlarged icon with aliases and a hidden mask,
        # one within-deadband icon, one absolute-path icon
        self.one = self.box.base_icon("fixture-one", 200)
        make_desktop(self.box.system_apps / "first.desktop", "First", "fixture-one")
        make_desktop(self.box.system_apps / "alias.desktop", "Alias", "fixture-one")
        make_desktop(self.box.system_apps / "masked.desktop", "Masked", "fixture-one")
        make_desktop(self.box.apps / "masked.desktop", "Mask", "fixture-one", extra="Hidden=true")
        self.box.base_icon("fixture-keep", 224)
        make_desktop(self.box.system_apps / "keep.desktop", "Keep", "fixture-keep")
        self.original_absolute = self.box.root / "vendor" / "icon.png"
        make_icon(self.original_absolute, 200, "blue")
        self.absolute = self.box.apps / "absolute.desktop"
        make_desktop(self.absolute, "Absolute", str(self.original_absolute))
        self.original_desktop = self.absolute.read_bytes()
        self.original_icon = self.original_absolute.read_bytes()

    def sync(self, apply: bool) -> dict:
        return self.box.build_engine().sync(apply)

    # 1 -------------------------------------------------------------------
    def test_01_dry_run_changes_nothing(self) -> None:
        dry = self.sync(False)
        self.assertTrue(dry["ok"])
        self.assertFalse(self.box.theme.exists())
        self.assertEqual(self.absolute.read_bytes(), self.original_desktop)
        summary = dry["summary"]
        self.assertEqual(summary["managed_icons"], 2)
        self.assertEqual(summary["managed_desktop_overrides"], 1)
        actions = summary["actions"]
        self.assertEqual(actions.get("enlarge"), 2)
        self.assertEqual(actions.get("keep"), 1)
        names = [row["icon_name"] for row in dry["apps"]]
        self.assertEqual(len(names), 3)
        self.assertIn("fixture-one", names)
        self.assertIn("fixture-keep", names)

    # 2 -------------------------------------------------------------------
    def test_02_first_apply(self) -> None:
        first = self.sync(True)
        self.assertTrue(first["ok"])
        self.assertTrue(first["summary"]["cache_valid"])
        self.assertEqual(self.original_absolute.read_bytes(), self.original_icon)
        generated = read_desktop_section(self.absolute.read_bytes())["Icon"]
        self.assertNotEqual(generated, str(self.original_absolute))
        self.assertTrue(Path(generated).exists())
        self.assertEqual(read_desktop_section(self.absolute.read_bytes())["Exec"], "/usr/bin/true")
        self.assertIn(b"Icon=action-untouched", self.absolute.read_bytes())
        self.assertFalse(list(self.box.theme.rglob("fixture-keep.png")))
        size_dirs = {p.parent.parent.name for p in self.box.theme.glob("*x*/apps/*.png")}
        self.assertEqual(size_dirs, {f"{n}x{n}" for n in
                                     (16, 24, 32, 48, 64, 96, 128, 256, 512)})

    # 3 -------------------------------------------------------------------
    def test_03_repeat_apply_is_idempotent(self) -> None:
        self.sync(True)
        content = png_hashes(self.box.theme)
        mtimes = {str(p): p.stat().st_mtime_ns for p in self.box.theme.rglob("*.png")}
        launch = self.absolute.read_bytes()
        second = self.sync(True)
        self.assertEqual(second["file_operations"], 0)
        self.assertEqual(second["summary"]["planned_file_changes"], 0)
        self.assertEqual(png_hashes(self.box.theme), content)
        self.assertEqual(self.absolute.read_bytes(), launch)
        for path, mtime in mtimes.items():
            self.assertEqual(Path(path).stat().st_mtime_ns, mtime)

    # 4 -------------------------------------------------------------------
    def test_04_source_update_detected(self) -> None:
        self.sync(True)
        content = png_hashes(self.box.theme)
        make_icon(self.one, 256, "green")
        updated = self.sync(True)
        self.assertGreater(updated["file_operations"], 0)
        self.assertNotEqual(png_hashes(self.box.theme), content)
        self.assertEqual(self.sync(True)["file_operations"], 0)

    # 5 -------------------------------------------------------------------
    def test_05_new_application_picked_up(self) -> None:
        self.sync(True)
        self.box.base_icon("fixture-new", 190, "purple")
        make_desktop(self.box.system_apps / "new.desktop", "New", "fixture-new")
        added = self.sync(True)
        self.assertEqual(added["summary"]["managed_icons"], 3)
        self.assertTrue((self.box.theme / "48x48" / "apps" / "fixture-new.png").exists())

    # 6 -------------------------------------------------------------------
    def test_06_uninstall_removes_stale_outputs(self) -> None:
        self.box.base_icon("fixture-new", 190, "purple")
        make_desktop(self.box.system_apps / "new.desktop", "New", "fixture-new")
        self.sync(True)
        (self.box.system_apps / "new.desktop").unlink()
        removed = self.sync(True)
        self.assertEqual(removed["summary"]["managed_icons"], 2)
        self.assertFalse(list(self.box.theme.rglob("fixture-new.png")))

    # 7 -------------------------------------------------------------------
    def test_07_missing_source_is_isolated(self) -> None:
        self.sync(True)
        make_desktop(self.box.system_apps / "missing.desktop", "Missing", "fixture-does-not-exist")
        saved = self.one.read_bytes()
        self.one.unlink()
        try:
            incomplete = self.sync(True)
            self.assertTrue(incomplete["ok"])
            self.assertEqual(len(incomplete["warnings"]), 2)
            engine = self.box.build_engine()
            self.assertIn("fixture-one", engine.manifest()["items"])
            self.assertTrue((self.box.theme / "48x48" / "apps" / "fixture-one.png").exists())
            self.assertEqual(incomplete["summary"]["managed_icons"], 2)
        finally:
            (self.box.system_apps / "missing.desktop").unlink()
            self.one.write_bytes(saved)
        self.assertTrue(self.sync(True)["ok"])

    # 8 -------------------------------------------------------------------
    def test_08_system_absolute_override_tracks_vendor(self) -> None:
        self.sync(True)
        sysabs = self.box.system_apps / "system-absolute.desktop"
        make_desktop(sysabs, "System Absolute", str(self.original_absolute))
        self.sync(True)
        local = self.box.apps / sysabs.name
        self.assertTrue(local.exists())
        make_desktop(sysabs, "System Absolute Updated", str(self.original_absolute))
        self.sync(True)
        self.assertEqual(read_desktop_section(local.read_bytes())["Name"],
                         "System Absolute Updated")
        sysabs.unlink()
        self.sync(True)
        self.assertFalse(local.exists())

    # 9 -------------------------------------------------------------------
    def test_09_rollback_preserves_user_edits(self) -> None:
        self.sync(True)
        self.absolute.write_bytes(
            self.absolute.read_bytes().replace(b"Name=Absolute", b"Name=User Edited")
        )
        self.sync(True)
        latest_original = self.original_desktop.replace(b"Name=Absolute", b"Name=User Edited")
        restored = self.box.build_engine().revert()
        self.assertTrue(restored["ok"])
        self.assertEqual(self.absolute.read_bytes(), latest_original)
        self.assertEqual(self.original_absolute.read_bytes(), self.original_icon)
        self.assertFalse(list(self.box.theme.rglob("*.png")))
        self.assertEqual(self.box.build_engine().manifest()["items"], {})

    # 10 ------------------------------------------------------------------
    def test_10_cache_failure_rolls_back(self) -> None:
        eng = self.box.build_engine()
        eng.sync(True)
        baseline_png = png_hashes(self.box.theme)
        baseline_launch = self.absolute.read_bytes()
        make_icon(self.one, 190, "yellow")
        original_rebuild = eng.rebuild_cache
        calls = []

        def fail_once(*args: object, **kwargs: object) -> None:
            calls.append(len(calls))
            if len(calls) == 1:
                raise RuntimeError("fixture cache failure")
            original_rebuild(*args, **kwargs)  # type: ignore[misc]

        eng.rebuild_cache = fail_once
        with self.assertRaises(RuntimeError):
            eng.sync(True)
        self.assertEqual(png_hashes(self.box.theme), baseline_png)
        self.assertEqual(self.absolute.read_bytes(), baseline_launch)
        self.assertFalse((self.box.state / "pending.json").exists())

    # 11 ------------------------------------------------------------------
    def test_11_interrupted_apply_recovers_from_journal(self) -> None:
        self.sync(True)
        target = self.box.theme / "48x48" / "apps" / "fixture-one.png"
        before = target.read_bytes()
        after = b"interrupted"
        atomic_write(target, after, 0o644)
        op = {
            "path": str(target),
            "before": base64.b64encode(before).decode(),
            "before_sha": sha_hex(before),
            "after_sha": sha_hex(after),
            "before_mode": 0o644,
        }
        pending = self.box.state / "pending.json"
        atomic_write(pending, json.dumps({"ops": [op]}).encode(), 0o600)
        self.assertTrue(self.box.build_engine().recover())
        self.assertEqual(target.read_bytes(), before)

    # 12 ------------------------------------------------------------------
    def test_12_unowned_collision_refused(self) -> None:
        self.sync(True)
        self.box.base_icon("fixture-new", 190, "purple")
        rogue = self.box.theme / "48x48" / "apps" / "fixture-new.png"
        atomic_write(rogue, b"user-content", 0o644)
        make_desktop(self.box.system_apps / "new.desktop", "New", "fixture-new")
        with self.assertRaises(RuntimeError) as ctx:
            self.sync(True)
        self.assertIn("collision", str(ctx.exception))
        self.assertEqual(rogue.read_bytes(), b"user-content")


class UserRuleLifecycle(unittest.TestCase):
    """ADR-0001 semantics: skip rules and SHA-bound manual classifications."""

    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.one = self.box.base_icon("fixture-one", 200)
        make_desktop(self.box.system_apps / "first.desktop", "First", "fixture-one")

    def test_skip_rule_removes_and_restores(self) -> None:
        self.box.build_engine().sync(True)
        atomic_write(
            self.box.state / "user-rules.json",
            json.dumps({"schema_version": 1, "icons": {
                "fixture-one": {"skip": True, "classification": "auto"},
            }}).encode(),
            0o600,
        )
        result = self.box.build_engine().sync(True)
        rows = {r["icon_name"]: r for r in result["apps"]}
        self.assertEqual(rows["fixture-one"]["action"], "skipped")
        self.assertEqual(rows["fixture-one"]["reason"], "user_skip")
        self.assertFalse(list(self.box.theme.rglob("fixture-one.png")))
        # un-skip restores the managed output
        atomic_write(
            self.box.state / "user-rules.json",
            json.dumps({"schema_version": 1, "icons": {}}).encode(),
            0o600,
        )
        self.box.build_engine().sync(True)
        self.assertTrue((self.box.theme / "48x48" / "apps" / "fixture-one.png").exists())

    def test_manual_glyph_rule_adds_plate(self) -> None:
        from PIL import Image, ImageDraw

        glyph = self.box.base / "256x256" / "apps" / "fixture-glyph.png"
        glyph.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGBA", (256, 256))
        ImageDraw.Draw(image).polygon([(100, 60), (170, 80), (150, 170), (90, 150)],
                                      fill=(30, 30, 40, 255))
        image.save(glyph)
        make_desktop(self.box.system_apps / "glyph.desktop", "Glyph", "fixture-glyph")
        digest = sha_hex(glyph.read_bytes())
        atomic_write(
            self.box.state / "user-rules.json",
            json.dumps({"schema_version": 1, "icons": {
                "fixture-glyph": {"skip": False, "classification": "glyph",
                                   "source_sha256": digest},
            }}).encode(),
            0o600,
        )
        result = self.box.build_engine().sync(True)
        rows = {r["icon_name"]: r for r in result["apps"]}
        self.assertEqual(rows["fixture-glyph"]["action"], "add_plate")
        self.assertEqual(rows["fixture-glyph"]["class"], "glyph")
        self.assertEqual(rows["fixture-glyph"]["classification_confidence"], "user")
        self.assertTrue((self.box.theme / "128x128" / "apps" / "fixture-glyph.png").exists())

    def test_stale_manual_rule_falls_back_to_auto(self) -> None:
        from PIL import Image, ImageDraw

        glyph = self.box.base / "256x256" / "apps" / "fixture-glyph.png"
        glyph.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGBA", (256, 256))
        ImageDraw.Draw(image).polygon([(100, 60), (170, 80), (150, 170), (90, 150)],
                                      fill=(30, 30, 40, 255))
        image.save(glyph)
        make_desktop(self.box.system_apps / "glyph.desktop", "Glyph", "fixture-glyph")
        old_digest = sha_hex(glyph.read_bytes())
        atomic_write(
            self.box.state / "user-rules.json",
            json.dumps({"schema_version": 1, "icons": {
                "fixture-glyph": {"skip": False, "classification": "glyph",
                                   "source_sha256": old_digest},
            }}).encode(),
            0o600,
        )
        # vendor updates the artwork; the SHA-bound rule must expire
        ImageDraw.Draw(image).rectangle((60, 60, 190, 190), fill=(30, 30, 40, 255))
        image.save(glyph)
        result = self.box.build_engine().sync(True)
        rows = {r["icon_name"]: r for r in result["apps"]}
        self.assertNotEqual(rows["fixture-glyph"]["class"], "glyph")
        self.assertNotEqual(rows["fixture-glyph"]["classification_confidence"], "user")


if __name__ == "__main__":
    unittest.main()
