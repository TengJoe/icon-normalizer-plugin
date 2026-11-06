"""Rules survive a source move across icon-size directories."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop

from icon_normalizer.core.classification import lookup_rule_ex


class LookupRuleEx(unittest.TestCase):
    def test_exact_match_wins(self):
        rules = {"/x/256x256/apps/foo.png": {"classification": "glyph"}}
        rule, how = lookup_rule_ex(rules, "/x/256x256/apps/foo.png")
        self.assertEqual(how, "exact")
        self.assertEqual(rule["classification"], "glyph")

    def test_sha_key_is_preferred_over_raw_path(self):
        from icon_normalizer.policy import sha_hex
        icon = "/x/256x256/apps/foo.png"
        rules = {sha_hex(icon.encode()): {"classification": "artwork"},
                 icon: {"classification": "glyph"}}
        rule, how = lookup_rule_ex(rules, icon)
        self.assertEqual((how, rule["classification"]), ("exact", "artwork"))

    def test_size_directory_move_falls_back_to_basename(self):
        rules = {"/x/256x256/apps/foo.png": {"classification": "glyph"}}
        rule, how = lookup_rule_ex(rules, "/x/512x512/apps/foo.png")
        self.assertEqual(how, "basename")
        self.assertEqual(rule["classification"], "glyph")

    def test_sha_key_uses_previous_path_mapping(self):
        from icon_normalizer.policy import sha_hex
        old = "/x/256x256/apps/foo.png"
        rules = {sha_hex(old.encode()): {"classification": "glyph"}}
        rule, how = lookup_rule_ex(rules, "/x/512x512/apps/foo.png",
                                   {sha_hex(old.encode()): old})
        self.assertEqual((how, rule["classification"]), ("basename", "glyph"))

    def test_unrelated_icon_does_not_match(self):
        rules = {"/x/256x256/apps/foo.png": {"classification": "glyph"}}
        self.assertEqual(lookup_rule_ex(rules, "/x/512x512/apps/bar.png"), (None, "none"))

    def test_ambiguous_basenames_are_refused(self):
        rules = {"/x/256x256/apps/foo.png": {"classification": "glyph"},
                 "/y/24x24/apps/foo.png": {"classification": "artwork"}}
        self.assertEqual(lookup_rule_ex(rules, "/x/512x512/apps/foo.png"), (None, "none"))


class SizeMoveKeepsRule(unittest.TestCase):
    """A PWA-style launcher points at an absolute icon path."""

    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.old_path = self.box.base_icon("rebind", 200)
        make_desktop(self.box.system_apps / "rebind.desktop", "Rebind", str(self.old_path))
        self.group = self.call("scan")["groups"][0]

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"],
                                   "activate": False})

    def apps_rows(self):
        apps_path = self.box.state / "last-run-apps.json"
        self.assertTrue(apps_path.exists(), sorted(p.name for p in self.box.state.iterdir()))
        return json.loads(apps_path.read_text())

    def test_rule_follows_the_icon_into_a_new_size_directory(self):
        # First run records the manifest entry with the original source path.
        self.apply()
        self.box.write_rules({self.group["icon_id"]: {
            "skip": False,
            "classification": "glyph",
            "source_sha256": self.group["source_sha256"],
        }})

        # An application update re-exports the same artwork into 512x512 and
        # refreshes the theme index accordingly.
        index = self.box.base / "index.theme"
        index.write_text(index.read_text()
            .replace("Directories=256x256/apps",
                     "Directories=256x256/apps,512x512/apps")
            .replace("Context=Applications",
                     "Context=Applications\n\n[512x512/apps]\nSize=512\nType=Fixed\nContext=Applications"))
        new_path = self.box.base / "512x512" / "apps" / "rebind.png"
        new_path.parent.mkdir(parents=True, exist_ok=True)
        new_path.write_bytes(self.old_path.read_bytes())
        self.old_path.unlink()
        # The application also rewrites its launcher to the new icon path.
        make_desktop(self.box.system_apps / "rebind.desktop", "Rebind", str(new_path))

        result = self.apply()
        self.assertEqual(result["summary"]["rule_warnings"], 0, result)

        rows = self.apps_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["rule_matched_by"], "basename")
        self.assertEqual(rows[0]["rule_state"], "active")
        self.assertEqual(rows[0]["class"], "glyph")


if __name__ == "__main__":
    unittest.main()
