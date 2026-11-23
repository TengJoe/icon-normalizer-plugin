"""Excluded launcher groups must say why they were excluded."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class ExcludedReason(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)

    def scan(self):
        rc, result = self.box.call_cli("scan", None)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return {g["icon_name"]: g for g in result["result"]["groups"]}

    def test_other_desktop_entry_reports_its_visibility_reason(self):
        source = self.box.base_icon("kdeonly", 200)
        make_desktop(self.box.system_apps / "kdeonly.desktop", "kdeonly", str(source),
                     extra="OnlyShowIn=NoSuchDesktop;\n")
        group = self.scan()[str(source)]
        self.assertEqual(group["action"], "excluded")
        self.assertEqual(group["reason"], "only_show_in_other_desktop")

    def test_visible_entry_is_not_excluded(self):
        source = self.box.base_icon("plain", 200)
        make_desktop(self.box.system_apps / "plain.desktop", "plain", str(source))
        group = self.scan()[str(source)]
        self.assertNotEqual(group["action"], "excluded")


if __name__ == "__main__":
    unittest.main()
