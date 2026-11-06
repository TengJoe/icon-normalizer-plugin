"""Unclaimed PNGs inside the managed theme are removed on the next run."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from harness import Sandbox, make_desktop


class OrphanCleanup(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("orphan", 200)
        make_desktop(self.box.system_apps / "orphan.desktop", "Orphan", "orphan")

    def call(self, operation, arguments=None):
        rc, result = self.box.call_cli(operation, arguments)
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["ok"], result)
        return result["result"]

    def apply(self):
        return self.call("apply", {"expected_revision": self.call("status")["revision"],
                                   "activate": False})

    def test_unclaimed_png_is_removed(self):
        self.apply()
        apps = self.box.home / ".local/share/icons/DockNormalized/48x48/apps"
        self.assertTrue(apps.is_dir(), sorted(p.name for p in apps.parents[2].iterdir()))
        stray = apps / "docknormalized-stale0000000000.png"
        stray.write_bytes((sorted(apps.glob("*.png"))[0]).read_bytes())
        self.assertTrue(stray.exists())

        self.apply()
        self.assertFalse(stray.exists(), "orphan PNG should be removed")


if __name__ == "__main__":
    unittest.main()
