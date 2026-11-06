"""Stale manual rules must stay observable instead of silently falling back."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop

from icon_normalizer.core.classification import (
    RULE_STATE_ACTIVE,
    RULE_STATE_INVALID,
    RULE_STATE_NONE,
    RULE_STATE_STALE,
    describe_rule,
    resolve_rule,
)


class DescribeRule(unittest.TestCase):
    """Unit level: the resolver explains why a rule did not apply."""

    def test_missing_rule(self):
        self.assertEqual(describe_rule(None, "a" * 64), (None, RULE_STATE_NONE, {}))
        self.assertEqual(describe_rule({"reset": True}, "a" * 64), (None, RULE_STATE_NONE, {}))

    def test_active_rule(self):
        decision, state, _detail = describe_rule({"classification": "glyph"}, "a" * 64)
        self.assertEqual(state, RULE_STATE_ACTIVE)
        self.assertEqual(decision["class"], "glyph")

    def test_class_alias_is_accepted(self):
        decision, state, _detail = describe_rule({"class": "glyph"}, "a" * 64)
        self.assertEqual((state, decision["class"]), (RULE_STATE_ACTIVE, "glyph"))

    def test_stale_fingerprint_is_reported(self):
        decision, state, detail = describe_rule(
            {"classification": "glyph", "source_sha256": "f" * 64}, "a" * 64)
        self.assertIsNone(decision)
        self.assertEqual(state, RULE_STATE_STALE)
        self.assertEqual(detail["expected_sha256"], "f" * 64)
        self.assertEqual(detail["actual_sha256"], "a" * 64)

    def test_unknown_class_is_invalid(self):
        decision, state, _detail = describe_rule({"classification": "nope"}, "a" * 64)
        self.assertIsNone(decision)
        self.assertEqual(state, RULE_STATE_INVALID)

    def test_skip_rule_stays_active(self):
        decision, state, detail = describe_rule({"skip": True}, "a" * 64)
        self.assertEqual((state, decision["skip"], detail["mode"]),
                         (RULE_STATE_ACTIVE, True, "skip"))

    def test_resolve_rule_keeps_legacy_contract(self):
        self.assertIsNone(resolve_rule(
            {"classification": "glyph", "source_sha256": "f" * 64}, "a" * 64))
        self.assertEqual(resolve_rule({"classification": "glyph"}, "a" * 64)["class"], "glyph")


class StaleRuleIsReported(unittest.TestCase):
    """Engine level: the run record exposes rules that stopped applying."""

    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("stale-rule", 200)
        make_desktop(self.box.system_apps / "stale-rule.desktop", "Stale rule", "stale-rule")
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

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"],
                                   "activate": False})

    def apps_rows(self):
        apps_path = self.box.state / "last-run-apps.json"
        self.assertTrue(apps_path.exists(), sorted(p.name for p in self.box.state.iterdir()))
        return json.loads(apps_path.read_text())

    def test_stale_rule_appears_in_summary_and_run_records(self):
        self.set_rule({"skip": False, "classification": "glyph", "source_sha256": "f" * 64})
        result = self.apply()

        self.assertEqual(result["summary"]["rule_warnings"], 1, result)

        record = json.loads((self.box.state / "last-run.json").read_text())
        self.assertEqual(record["summary"]["rule_warnings"], 1)
        warnings = record.get("rule_warnings", [])
        self.assertEqual(len(warnings), 1, record)
        self.assertEqual(warnings[0]["error"], "RULE_STALE_SOURCE")
        self.assertEqual(warnings[0]["detail"]["actual_sha256"], self.group["source_sha256"])

        rows = self.apps_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["rule_state"], RULE_STATE_STALE)

    def test_active_rule_produces_no_warning(self):
        self.set_rule({"skip": False, "classification": "glyph",
                       "source_sha256": self.group["source_sha256"]})
        result = self.apply()
        self.assertEqual(result["summary"]["rule_warnings"], 0, result)
        rows = self.apps_rows()
        self.assertEqual(rows[0]["rule_state"], RULE_STATE_ACTIVE)

    def test_stale_rule_records_health_event(self):
        self.set_rule({"skip": False, "classification": "glyph", "source_sha256": "f" * 64})
        self.apply()
        payload = json.loads((self.box.state / "health-events.json").read_text())
        history = payload if isinstance(payload, list) else payload.get("history", [])
        degraded = [e for e in history if e.get("kind") == "degraded"]
        self.assertTrue(degraded, payload)
        self.assertEqual(degraded[-1]["code"], "RULE_STALE")


if __name__ == "__main__":
    unittest.main()
