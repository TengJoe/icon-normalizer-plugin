"""Desktop entry scanning, visibility and surgical Icon= rewriting tests."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.desktop import (  # noqa: E402
    application_roots,
    collect_desktop_entries,
    entry_visibility,
    read_desktop_section,
    rewrite_icon_line,
)

from harness import make_desktop  # noqa: E402


class TestVisibility(unittest.TestCase):
    def _entry(self, **kw: str) -> dict:
        base = {"Type": "Application", "Exec": "/usr/bin/true"}
        base.update(kw)
        return base

    def test_visible(self) -> None:
        self.assertEqual(entry_visibility(self._entry(), "GNOME"), "visible")

    def test_hidden_and_no_display(self) -> None:
        self.assertEqual(entry_visibility(self._entry(Hidden="true"), "GNOME"), "hidden")
        self.assertEqual(entry_visibility(self._entry(NoDisplay="true"), "GNOME"), "no_display")

    def test_only_show_in(self) -> None:
        entry = self._entry(OnlyShowIn="KDE;")
        self.assertEqual(entry_visibility(entry, "GNOME"), "only_show_in_other_desktop")
        self.assertEqual(entry_visibility(entry, "KDE"), "visible")

    def test_not_show_in(self) -> None:
        entry = self._entry(NotShowIn="GNOME;")
        self.assertEqual(entry_visibility(entry, "GNOME"), "not_show_in_current_desktop")

    def test_missing_exec(self) -> None:
        self.assertEqual(entry_visibility(self._entry(Exec="/nonexistent-bin-xyz"), "GNOME"),
                         "exec_missing")
        self.assertEqual(entry_visibility(self._entry(Exec=""), "GNOME"), "exec_missing")
        self.assertEqual(entry_visibility(self._entry(Exec="", DBusActivatable="true"), "GNOME"),
                         "visible")


class TestRewriteIconLine(unittest.TestCase):
    def test_surgical_rewrite_preserves_actions_and_formatting(self) -> None:
        original = (
            "[Desktop Entry]\r\n"
            "Type=Application\r\n"
            "Name=Test\r\n"
            "Icon=old-icon\r\n"
            "Exec=/usr/bin/true\r\n"
            "\n"
            "[Desktop Action Extra]\n"
            "Icon=action-untouched\n"
            "Exec=/usr/bin/true\n"
        ).encode()
        rewritten = rewrite_icon_line(original, "new-icon")
        self.assertEqual(
            rewritten,
            original.replace(b"Icon=old-icon", b"Icon=new-icon"),
        )
        self.assertIn(b"Icon=action-untouched", rewritten)
        section = read_desktop_section(rewritten)
        self.assertEqual(section["Icon"], "new-icon")

    def test_no_icon_field_raises(self) -> None:
        with self.assertRaises(ValueError):
            rewrite_icon_line(b"[Desktop Entry]\nType=Application\n", "x")

    def test_newline_in_icon_rejected(self) -> None:
        with self.assertRaises(ValueError):
            rewrite_icon_line(b"[Desktop Entry]\nIcon=old\n", "bad\nicon")


class TestCollect(unittest.TestCase):
    def test_grouping_and_shadowing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            apps = home / ".local/share/applications"
            system_apps = root / "system/share/applications"
            make_desktop(system_apps / "first.desktop", "First", "icon-a")
            make_desktop(system_apps / "alias.desktop", "Alias", "icon-a")
            make_desktop(system_apps / "masked.desktop", "Masked", "icon-a")
            make_desktop(apps / "masked.desktop", "Mask", "icon-a", extra="Hidden=true")
            make_desktop(system_apps / "link.desktop", "Link", "/abs/path.png")
            grouped, counts, errors = collect_desktop_entries(
                "GNOME", home, application_dirs=[str(apps), str(system_apps)]
            )
            self.assertEqual(errors, [])
            self.assertEqual(set(grouped), {"icon-a", "/abs/path.png"})
            # The hidden user entry masks the system one: neither contributes a ref.
            masked = [r for r in grouped["icon-a"] if r.desktop_id == "masked.desktop"]
            self.assertEqual(len(masked), 0)
            self.assertEqual(counts.get("shadowed_entries"), 1)
            self.assertEqual(counts.get("hidden"), 1)
            names = sorted(r.name for r in grouped["icon-a"])
            self.assertEqual(names, ["Alias", "First"])

    def test_application_roots_order(self) -> None:
        home = Path("/home/test")
        roots = application_roots(home, data_dirs="/usr/local/share:/usr/share")
        self.assertEqual(roots[0], Path("/home/test/.local/share/applications"))
        self.assertIn(Path("/usr/share/applications"), roots)
        self.assertIn(Path("/var/lib/flatpak/exports/share/applications"), roots)
        # first-seen order, deduplicated
        self.assertEqual(len(roots), len(set(roots)))


if __name__ == "__main__":
    unittest.main()
