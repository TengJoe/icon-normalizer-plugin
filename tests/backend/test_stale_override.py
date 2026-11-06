"""Reviewed overrides that stopped matching must be reported."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class StaleOverrideIsReported(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.source = self.box.base_icon("stale-ov", 200)
        make_desktop(self.box.system_apps / "stale-ov.desktop", "Stale ov", str(self.source))

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def write_override(self, sha):
        (self.box.state / "overrides.json").write_text(json.dumps({
            "schema_version": 1,
            "icons": {str(self.source): {"class": "glyph", "source_sha256": sha}},
        }))

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"],
                                   "activate": False})

    def test_stale_override_is_reported(self):
        self.write_override("f" * 64)
        result = self.apply()
        self.assertGreaterEqual(result["summary"]["rule_warnings"], 1, result)
        record = json.loads((self.box.state / "last-run.json").read_text())
        errors = [w["error"] for w in record.get("rule_warnings", [])]
        self.assertIn("OVERRIDE_STALE_SOURCE", errors)

    def test_matching_override_is_silent(self):
        self.apply()
        record = json.loads((self.box.state / "last-run.json").read_text())
        self.assertEqual(record["summary"]["rule_warnings"], 0)
        self.assertEqual(self.call("status")["revision"], record["revision"])


if __name__ == "__main__":
    unittest.main()
