"""status exposes a rules-health summary derived from the last run detail."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class StatusRulesHealth(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("rules-health", 200)
        make_desktop(self.box.system_apps / "rules-health.desktop", "Rules", "rules-health")

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def test_status_reports_rule_states_after_apply(self):
        group = self.call("scan")["groups"][0]
        self.call("apply", {"expected_revision": self.call("status")["revision"],
                            "activate": False})
        status = self.call("status")
        health = status.get("rules_health")
        self.assertIsNotNone(health, status)
        self.assertEqual(health["warnings"], 0)
        self.assertEqual(health["states"]["none"], 1)

        self.call("rules.set", {"expected_revision": status["revision"],
                                "icon_id": group["icon_id"],
                                "rule": {"skip": False, "classification": "glyph",
                                         "source_sha256": group["source_sha256"]}})
        self.call("apply", {"expected_revision": self.call("status")["revision"],
                            "activate": False})
        health2 = self.call("status")["rules_health"]
        self.assertEqual(health2["states"]["active"], 1)
        self.assertEqual(health2["states"]["none"], 0)


if __name__ == "__main__":
    unittest.main()
