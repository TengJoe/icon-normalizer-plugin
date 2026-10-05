"""Real install/uninstall regression in a private temporary HOME.

Exercises the actual installer pipeline: precheck → stage → atomic swap →
units → extension → status probe, plus the uninstall path with backend
revert. systemd calls degrade gracefully when no user session exists.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tests'))
from isolation import isolated_env
sys.path.insert(0, str(REPO / "tools"))
from layout import backend_version


def run_installer(args: list[str], home: Path, timeout: int = 300) -> tuple[int, str, str]:
    env = isolated_env(home.parent)
    env["HOME"] = str(home)
    env.pop("XDG_DATA_HOME", None)
    proc = subprocess.run(
        [sys.executable, str(REPO / "tools" / "install.py"), *args],
        capture_output=True, text=True, env=env, timeout=timeout, check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def extract_json(text: str) -> dict | None:
    start = text.find("{")
    if start < 0:
        return None
    try:
        return json.loads(text[start:text.rfind("}") + 1])
    except Exception:
        return None


class Installation(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="icon-norm-install-")
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir(parents=True)
        self.addCleanup(self._tmp.cleanup)

    def test_fresh_install_repeat_and_uninstall(self) -> None:
        rc, out, err = run_installer(["--assume-yes"], self.home)
        payload = extract_json(out)
        self.assertIsNotNone(payload, f"installer produced no JSON: {out!r} {err!r}")
        self.assertEqual(rc, 0, f"install failed: {payload or err}")
        self.assertTrue(payload["ok"])
        libexec = self.home / ".local/libexec/icon-normalizer"
        ext = self.home / f".local/share/gnome-shell/extensions/icon-normalizer@joeydeng.local"
        units = self.home / ".config/systemd/user"
        self.assertTrue((libexec / "control.py").exists())
        self.assertTrue((libexec / "icon_normalizer" / "core" / "engine.py").exists())
        self.assertTrue((libexec / "overrides.json").exists())
        self.assertTrue((ext / "metadata.json").exists())
        self.assertTrue((ext / "schemas" / "gschemas.compiled").exists())
        self.assertTrue((units / "icon-normalizer.service").exists())
        # A scheduled run that skips on lock contention exits with EXIT_BUSY (3);
        # systemd must treat it as success, not as a unit failure.
        self.assertIn("SuccessExitStatus=3",
                      (units / "icon-normalizer.service").read_text())
        self.assertTrue((units / "icon-normalizer.timer").exists())
        self.assertTrue((units / "icon-normalizer.path").exists())
        self.assertEqual((self.home/'.local/share/icons/DockNormalized/.icon-normalizer-owned').read_text(),
                         'icon-normalizer-owned-v1\n')
        self.assertTrue((self.home/'.cache/icon-normalizer').is_dir())

        # repeat install is safe
        rc, out, err = run_installer(["--assume-yes"], self.home)
        payload = extract_json(out)
        self.assertEqual(rc, 0)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["upgraded"])

        # keep-backend uninstall removes only the panel
        rc, out, _ = run_installer(["--uninstall", "--keep-backend"], self.home)
        payload = extract_json(out)
        self.assertEqual(rc, 0, err)
        self.assertTrue((libexec / "control.py").exists())
        self.assertFalse(ext.exists())
        self.assertTrue(all((units / ('icon-normalizer.' + suffix)).exists()
                            for suffix in ('service', 'timer', 'path')))
        manager = json.loads((self.home.parent/'test-manager.json').read_text())
        for suffix in ('timer','path'):
            self.assertEqual(manager['units']['icon-normalizer.'+suffix],
                             {'enabled':True,'active':True})

        # full uninstall removes everything but keeps backups
        rc, out, _ = run_installer(["--uninstall"], self.home)
        self.assertEqual(rc, 0)
        self.assertFalse(libexec.exists())
        self.assertFalse(ext.exists())
        self.assertFalse((units / "icon-normalizer.timer").exists())

    def test_status_probe_matches_protocol(self) -> None:
        rc, out, _err = run_installer(["--assume-yes"], self.home)
        self.assertEqual(rc, 0, out)
        libexec = self.home / ".local/libexec/icon-normalizer/control.py"
        request = json.dumps({
            "api_version": 1, "request_id": "install-test",
            "operation": "status", "arguments": {},
        })
        proc = subprocess.run(
            [sys.executable, str(libexec), "--json"],
            input=request.encode(), capture_output=True, timeout=60, check=False,
            env={**isolated_env(self.home.parent), "HOME": str(self.home)},
        )
        envelope = json.loads(proc.stdout.decode())
        self.assertTrue(envelope["ok"])
        result = envelope["result"]
        self.assertEqual(result["backend_version"], backend_version())
        self.assertFalse(result["installed"])
        # the shim's package import works from the installed layout
        self.assertNotIn("Traceback", proc.stderr.decode())


class SnapshotRetentionTests(unittest.TestCase):
    """A successful install must not let snapshots grow without bound."""

    def _make(self, backups: Path, prefix: str, count: int) -> list[str]:
        names = [f"{prefix}{index:02d}" for index in range(count)]
        for index, name in enumerate(names):
            directory = backups / name
            directory.mkdir()
            stamp = 1000 + index
            os.utime(directory, (stamp, stamp))
        return names

    def test_old_install_snapshots_are_pruned(self):
        from install import SNAPSHOT_KEEP, prune_install_snapshots
        with tempfile.TemporaryDirectory() as tmp:
            backups = Path(tmp) / "backups"
            backups.mkdir()
            names = self._make(backups, "install-snapshot-", SNAPSHOT_KEEP + 3)
            removed = prune_install_snapshots(SimpleNamespace(backups=backups))
            remaining = sorted(p.name for p in backups.iterdir())
            self.assertEqual(sorted(removed), names[:3])
            self.assertEqual(remaining, names[3:])

    def test_uninstall_snapshots_survive_install(self):
        # Uninstall snapshots are the user-visible way back after a removal,
        # so an ordinary install must leave them alone.
        from install import prune_install_snapshots
        with tempfile.TemporaryDirectory() as tmp:
            backups = Path(tmp) / "backups"
            backups.mkdir()
            self._make(backups, "install-snapshot-", 9)
            kept = self._make(backups, "uninstall-snapshot-", 3)
            prune_install_snapshots(SimpleNamespace(backups=backups))
            for name in kept:
                self.assertTrue((backups / name).is_dir())


if __name__ == "__main__":
    unittest.main()
