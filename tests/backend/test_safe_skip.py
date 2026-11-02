"""Skip-only updates preserve existing per-icon rules and enforce OCC."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class SafeSkip(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("safe-skip", 200)
        make_desktop(self.box.system_apps / "safe-skip.desktop", "Safe skip", "safe-skip")
        self.group = self.call("scan")["groups"][0]
        self.icon_id = self.group["icon_id"]

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def set_rule(self, rule):
        return self.call("rules.set", {"expected_revision": self.call("status")["revision"],
                                      "icon_id": self.icon_id, "rule": rule})

    def set_reviewed_override(self):
        (self.box.state / "overrides.json").write_text(json.dumps({"schema_version": 1,
            "icons": {"safe-skip": {"class": "glyph", "source_sha256": self.group["source_sha256"],
                                     "reason": "fixture"}}}))

    def classification_origin(self):
        return self.call("preview", {"icon_id": self.icon_id,
            "source_sha256": self.group["source_sha256"], "size": 48})["classification_origin"]

    def test_manual_classification_and_fingerprint_survive_skip_roundtrip(self):
        original = {"skip": False, "classification": "glyph", "source_sha256": self.group["source_sha256"]}
        self.set_rule(original)
        self.set_rule({"skip": True})
        self.assertEqual(self.box.rules()["icons"][self.icon_id], {**original, "skip": True})
        skipped = self.call("preview", {"icon_id": self.icon_id,
            "source_sha256": self.group["source_sha256"], "size": 48})
        self.assertTrue(skipped["skipped"])
        self.set_rule({"skip": False})
        self.assertEqual(self.box.rules()["icons"][self.icon_id], original)
        restored = self.call("preview", {"icon_id": self.icon_id,
            "source_sha256": self.group["source_sha256"], "size": 48})
        self.assertEqual((restored["classification"], restored["classification_origin"]), ("glyph", "user"))

    def test_stale_manual_source_fingerprint_is_preserved(self):
        original = {"skip": False, "classification": "glyph", "source_sha256": "f" * 64}
        self.set_rule(original)
        self.set_rule({"skip": True})
        self.set_rule({"skip": False})
        self.assertEqual(self.box.rules()["icons"][self.icon_id], original)

    def test_skip_only_roundtrip_removes_ephemeral_rule(self):
        before = self.call("status")["revision"]
        self.set_rule({"skip": False})
        self.assertFalse((self.box.state / "user-rules.json").exists())
        self.set_rule({"skip": True})
        self.assertTrue(self.box.rules()["icons"][self.icon_id]["skip"])
        snapshot = (self.box.state / "user-rules.json").read_bytes()
        unchanged_revision = self.call("status")["revision"]
        self.set_rule({"skip": True})
        self.assertEqual((self.box.state / "user-rules.json").read_bytes(), snapshot)
        self.assertEqual(self.call("status")["revision"], unchanged_revision)
        self.set_rule({"skip": False})
        self.assertNotIn(self.icon_id, self.box.rules()["icons"])
        self.assertEqual(self.call("status")["revision"], before)

    def test_explicit_auto_rule_survives_skip_roundtrip(self):
        self.set_reviewed_override()
        original = {"skip": False, "classification": "auto"}
        self.set_rule(original)
        self.assertEqual(self.classification_origin(), "automatic")
        self.set_rule({"skip": True})
        self.set_rule({"skip": False})
        self.assertEqual(self.box.rules()["icons"][self.icon_id], original)
        self.assertEqual(self.classification_origin(), "automatic")

    def test_legacy_skip_only_rule_unskips_to_default(self):
        self.set_reviewed_override()
        self.set_rule({"skip": True, "classification": "auto"})
        self.set_rule({"skip": False})
        self.assertNotIn(self.icon_id, self.box.rules()["icons"])
        self.assertEqual(self.classification_origin(), "reviewed")

    def test_new_skip_only_rule_restores_reviewed_override(self):
        self.set_reviewed_override()
        self.assertEqual(self.classification_origin(), "reviewed")
        self.set_rule({"skip": True})
        self.set_rule({"skip": False})
        self.assertEqual(self.classification_origin(), "reviewed")

    def test_stale_revision_cannot_clobber_manual_rule(self):
        old_revision = self.call("status")["revision"]
        self.set_rule({"skip": False, "classification": "glyph", "source_sha256": self.group["source_sha256"]})
        before = (self.box.state / "user-rules.json").read_bytes()
        rc, response = self.box.call_cli("rules.set", {"expected_revision": old_revision,
            "icon_id": self.icon_id, "rule": {"skip": True}})
        self.assertEqual((rc, response["error"]["code"]), (3, "REVISION_CONFLICT"))
        self.assertEqual((self.box.state / "user-rules.json").read_bytes(), before)

    def test_partial_skip_request_matches_public_schema(self):
        import jsonschema
        schema = json.loads((Path(__file__).resolve().parents[2] / "contracts/request.schema.json").read_text())
        request = {"api_version": 1, "request_id": "test", "operation": "rules.set",
                   "arguments": {"expected_revision": self.call("status")["revision"],
                                 "icon_id": self.icon_id, "rule": {"skip": True}}}
        jsonschema.validate(request, schema)
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate({**request, "arguments": {**request["arguments"], "rule": {"skip": "yes"}}}, schema)
        rc, invalid = self.box.call_cli("rules.set", {**request["arguments"], "rule": {"skip": "yes"}})
        self.assertEqual((rc, invalid["error"]["code"]), (2, "INVALID_REQUEST"))


if __name__ == "__main__":
    unittest.main()
