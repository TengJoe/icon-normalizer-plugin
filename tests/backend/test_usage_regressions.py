"""Complete protocol regressions found after several days of desktop use."""
import base64
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from PIL import Image
from icon_normalizer.core.analyzer import analyze
from harness import Sandbox, make_desktop, make_icon, INDEX_THEME


class UsageRegressions(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.source = self.box.base_icon("fixture-rule", 200)
        self.box.base_icon("fixture-keep", 224)
        make_desktop(self.box.system_apps / "rule.desktop", "Rule", "fixture-rule")
        make_desktop(self.box.system_apps / "keep.desktop", "Keep", "fixture-keep")
        self.groups = {g["icon_name"]: g for g in self.call("scan")["groups"]}

    def call(self, operation, arguments=None):
        rc, response = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, response)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"], "activate": False})

    def rule(self, rule):
        return self.call("rules.set", {"expected_revision": self.call("status")["revision"],
            "icon_id": self.groups["fixture-rule"]["icon_id"], "rule": rule})

    def preview_args(self, name="fixture-rule", **extra):
        group = self.groups[name]
        return {"icon_id": group["icon_id"], "source_sha256": group["source_sha256"], "size": 48, **extra}

    def test_skip_rule_removes_managed_outputs_and_reset_restores(self):
        self.apply()
        self.assertTrue(list(self.box.theme.rglob("*.png")))
        self.rule({"skip": True, "classification": "auto"})
        self.apply()
        manifest = json.loads((self.box.state / "manifest.json").read_text())
        self.assertEqual(manifest["items"]["fixture-rule"]["files"], {})
        self.assertFalse(list(self.box.theme.rglob("*.png")))
        self.rule({"reset": True})
        self.apply()
        self.assertTrue(list(self.box.theme.rglob("*.png")))

    def test_manual_classification_reaches_rendered_manifest(self):
        group = self.groups["fixture-rule"]
        self.rule({"skip": False, "classification": "glyph", "source_sha256": group["source_sha256"]})
        self.apply()
        manifest = json.loads((self.box.state / "manifest.json").read_text())
        self.assertEqual(manifest["items"]["fixture-rule"]["class"], "glyph")

    def test_upgrade_invalidates_legacy_ignored_manual_rule_cache(self):
        from icon_normalizer.policy import canonical_json, sha_hex
        self.apply()
        group = self.groups["fixture-rule"]
        self.rule({"skip": False, "classification": "glyph", "source_sha256": group["source_sha256"]})
        path = self.box.state / "manifest.json"
        manifest = json.loads(path.read_text())
        rules = self.box.rules()["icons"]
        legacy_policy = sha_hex((manifest["policy_sha256"] + canonical_json({}) + canonical_json(rules)).encode())
        cached = manifest["analysis_cache"]["fixture-rule"]
        cached["key"] = sha_hex((str(self.source) + group["source_sha256"] + legacy_policy).encode())
        path.write_text(json.dumps(manifest))
        self.apply()
        fixed = json.loads(path.read_text())
        self.assertEqual(fixed["items"]["fixture-rule"]["class"], "glyph")

    def test_preview_rejects_changed_source_even_after_cache_hit(self):
        self.call("preview", self.preview_args())
        make_icon(self.source, 200, "blue")
        rc, response = self.box.call_cli("preview", self.preview_args())
        self.assertEqual((rc, response.get("error", {}).get("code")), (5, "STALE_SOURCE"))

    def test_preview_refresh_request_does_not_pollute_persistent_health(self):
        rc, response = self.box.call_cli("preview", {
            **self.preview_args(), "source_sha256": "f" * 64})
        self.assertEqual((rc, response.get("error", {}).get("code")), (5, "STALE_SOURCE"))
        self.assertIsNone(self.call("status")["last_error"])

    def test_preview_rejects_missing_source_even_after_cache_hit(self):
        self.call("preview", self.preview_args())
        self.source.unlink()
        rc, response = self.box.call_cli("preview", self.preview_args())
        self.assertEqual((rc, response.get("error", {}).get("code")), (5, "STALE_SOURCE"))

    def test_preview_replans_keep_icon_for_draft_parameters(self):
        result = self.call("preview", self.preview_args("fixture-keep", draft={"target": .50}))
        self.assertEqual(result["action"], "shrink")
        img = Image.open(io.BytesIO(base64.b64decode(result["proposed_png_base64"]))).convert("RGBA")
        self.assertAlmostEqual(analyze(img).source_ratio, .50, delta=.04)

    def test_preview_uses_current_manual_rule_without_rescan(self):
        group = self.groups["fixture-rule"]
        self.rule({"skip": False, "classification": "glyph", "source_sha256": group["source_sha256"]})
        result = self.call("preview", self.preview_args())
        self.assertEqual((result["classification"], result["action"]), ("glyph", "add_plate"))

    def test_preview_rejects_scan_from_previous_source_theme(self):
        self.box.write_config(base_theme="FixtureOther")
        rc, response = self.box.call_cli("preview", self.preview_args())
        self.assertEqual((rc, response.get("error", {}).get("code")), (5, "STALE_SOURCE"))

    def test_status_marks_unapplied_rule_changes_stale(self):
        self.apply()
        self.assertFalse(self.call("status")["stale"])
        self.rule({"skip": True, "classification": "auto"})
        self.assertTrue(self.call("status")["stale"])
        self.apply()
        self.assertFalse(self.call("status")["stale"])

    def test_original_preview_uses_native_size_from_selected_source_theme(self):
        index = INDEX_THEME.replace("Directories=256x256/apps", "Directories=256x256/apps,48x48/apps")
        index += "\n[48x48/apps]\nSize=48\nType=Fixed\nContext=Applications\n"
        (self.box.base / "index.theme").write_text(index)
        native = self.box.base / "48x48/apps/fixture-keep.png"
        native.parent.mkdir(parents=True)
        Image.new("RGBA", (48, 48), "blue").save(native)
        result = self.call("preview", self.preview_args("fixture-keep"))
        original = Image.open(io.BytesIO(base64.b64decode(result["original_png_base64"]))).convert("RGBA")
        self.assertEqual(original.getpixel((24, 24)), (0, 0, 255, 255))


if __name__ == "__main__":
    unittest.main()
