"""Skipping an icon must not always rewrite the launcher icon line."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class SkipKeepsDesktopOverride(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"],
                                   "activate": False})

    def icon_line(self, path):
        for line in path.read_text().splitlines():
            if line.startswith("Icon="):
                return line[5:]
        return None

    def prepare(self, name):
        source = self.box.base_icon(name, 200)
        make_desktop(self.box.system_apps / f"{name}.desktop", name, str(source))
        # The plugin manages a user-level launcher; the system file stays intact.
        return source, self.box.home / ".local/share/applications" / f"{name}.desktop"

    def icon_id_for(self, name):
        groups = self.call("scan")["groups"]
        if len(groups) != 1:
            self.fail(f"expected a single scan group, got {len(groups)}")
        return groups[0]["icon_id"]

    def test_keep_desktop_override_leaves_the_launcher_untouched(self):
        source, desktop = self.prepare("keep")
        self.apply()
        managed = self.icon_line(desktop)
        self.assertNotEqual(managed, str(source))

        self.call("rules.set", {"expected_revision": self.call("status")["revision"],
                                "icon_id": self.icon_id_for("keep"),
                                "rule": {"skip": True, "keep_desktop_override": True}})
        self.apply()
        self.assertEqual(self.icon_line(desktop), managed)

    def test_default_skip_releases_the_generated_launcher(self):
        source, desktop = self.prepare("revert")
        self.apply()
        self.assertTrue(desktop.exists())
        self.assertNotEqual(self.icon_line(desktop), str(source))

        self.call("rules.set", {"expected_revision": self.call("status")["revision"],
                                "icon_id": self.icon_id_for("revert"),
                                "rule": {"skip": True}})
        self.apply()
        # The launcher did not exist before the plugin created it, so releasing
        # the override removes it and the system entry takes over again.
        self.assertFalse(desktop.exists())


if __name__ == "__main__":
    unittest.main()
