"""End-to-end CLI tests over the real protocol (sandboxed, subprocess-based)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.config_store import ConfigStore, PolicyDefaults  # noqa: E402
from icon_normalizer.preview import hash_icon_name  # noqa: E402

from harness import Sandbox, make_desktop  # noqa: E402

HEX = "f" * 64


class ControlE2E(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("fixture-one", 200)
        make_desktop(self.box.system_apps / "first.desktop", "First", "fixture-one")

    def test_scan_reports_groups(self) -> None:
        rc, envelope = self.box.call_cli("scan")
        self.assertEqual(rc, 0)
        self.assertTrue(envelope["ok"])
        groups = envelope["result"]["groups"]
        self.assertEqual(len(groups), 1)
        group = groups[0]
        self.assertEqual(group["icon_name"], "fixture-one")
        self.assertEqual(group["action"], "enlarge")
        self.assertEqual(group["desktop_ids"], ["first.desktop"])
        self.assertEqual(group["classification_origin"], "automatic")
        self.assertEqual(group["icon_id"], hash_icon_name("fixture-one"))
        self.assertTrue((self.box.state / "last-scan.json").exists())
        self.assertNotIn("groups", envelope["result"]["summary"] or {})

    def test_revision_conflict_and_success(self) -> None:
        rc, status = self.box.call_cli("status")
        self.assertEqual((rc, status["ok"]), (0, True))
        revision = status["result"]["revision"]
        rc, env = self.box.call_cli("configure", {"expected_revision": HEX, "patch": {"target": 0.9}})
        self.assertEqual(rc, 3)
        self.assertEqual(env["error"]["code"], "REVISION_CONFLICT")
        self.assertEqual(env["error"]["details"]["current_revision"], revision)
        rc, env = self.box.call_cli("configure", {"expected_revision": revision,
                                                  "patch": {"target": 0.9}})
        self.assertEqual((rc, env["ok"]), (0, True))
        self.assertTrue(env["result"]["changed"])
        self.assertEqual(env["result"]["effective_policy"]["target"], 0.9)
        self.assertNotEqual(env["result"]["revision"], revision)

    def test_noop_configure_writes_nothing(self) -> None:
        _, status = self.box.call_cli("status")
        revision = status["result"]["revision"]
        config = self.box.config_path.read_bytes()
        mtime = self.box.config_path.stat().st_mtime_ns
        rc, env = self.box.call_cli("configure", {"expected_revision": revision,
                                                  "patch": {"target": 0.88}})
        self.assertEqual((rc, env["result"]["changed"]), (0, False))
        self.assertEqual(self.box.config_path.read_bytes(), config)
        self.assertEqual(self.box.config_path.stat().st_mtime_ns, mtime)

    def test_scan_blocked_by_pending_then_apply_recovers(self) -> None:
        self.box.state.mkdir(parents=True, exist_ok=True)
        (self.box.state / "pending.json").write_text('{"ops": []}')
        rc, env = self.box.call_cli("scan")
        self.assertEqual((rc, env["error"]["code"]), (5, "RECOVERY_REQUIRED"))
        rc, env = self.box.call_cli("apply", {"expected_revision": HEX, "activate": False})
        self.assertEqual(env["error"]["code"], "REVISION_CONFLICT")  # apply checks revision first
        _, status = self.box.call_cli("status")
        revision = status["result"]["revision"]
        rc, env = self.box.call_cli("apply", {"expected_revision": revision, "activate": False})
        self.assertEqual((rc, env["ok"]), (0, True))
        self.assertFalse((self.box.state / "pending.json").exists())

    def test_rules_set_persists(self) -> None:
        _, status = self.box.call_cli("status")
        revision = status["result"]["revision"]
        icon_id = hash_icon_name("fixture-one")
        rc, env = self.box.call_cli("rules.set", {
            "expected_revision": revision, "icon_id": icon_id,
            "rule": {"skip": True, "classification": "auto"},
        })
        self.assertEqual((rc, env["ok"]), (0, True))
        rules = json.loads((self.box.state / "user-rules.json").read_text())
        self.assertEqual(rules["icons"][icon_id]["skip"], True)
        rc, env = self.box.call_cli("rules.set", {
            "expected_revision": revision, "icon_id": icon_id,
            "rule": {"skip": True, "classification": "auto", "source_sha256": "a" * 64},
        })
        self.assertEqual((rc, env["error"]["code"]), (2, "INVALID_REQUEST"))
        # revision changed by the first write: stale revision now conflicts
        rc, env = self.box.call_cli("rules.set", {
            "expected_revision": revision, "icon_id": icon_id, "rule": {"reset": True},
        })
        self.assertEqual(env["error"]["code"], "REVISION_CONFLICT")

    def test_status_shape_and_staleness(self) -> None:
        rc, env = self.box.call_cli("status")
        result = env["result"]
        for key in ("installed", "backend_version", "revision", "automatic", "units",
                    "busy", "recovery_pending", "active_theme", "source_theme",
                    "overlay_in_use", "last_apply_at", "last_scan_at", "summary",
                    "stale", "last_error"):
            self.assertIn(key, result)
        self.assertFalse(result["installed"])
        # doctor runs lock-free and reports dependencies
        rc, env = self.box.call_cli("doctor")
        self.assertEqual((rc, env["ok"]), (0, True))
        self.assertIn("pillow", env["result"]["checks"])

    def test_oversize_request_rejected(self) -> None:
        request = {
            "api_version": 1, "request_id": "x", "operation": "scan",
            "arguments": {"pad": "y" * 70000},
        }
        import subprocess

        proc = subprocess.run(
            [sys.executable, "-m", "icon_normalizer", "--json"],
            input=json.dumps(request).encode(),
            capture_output=True, env=self.box.env(), timeout=60, check=False,
        )
        payload = json.loads(proc.stdout.decode())
        self.assertEqual(payload["error"]["code"], "INVALID_REQUEST")

    def test_stdin_garbage_returns_envelope(self) -> None:
        import subprocess

        proc = subprocess.run(
            [sys.executable, "-m", "icon_normalizer", "--json"],
            input=b"not json at all",
            capture_output=True, env=self.box.env(), timeout=60, check=False,
        )
        payload = json.loads(proc.stdout.decode())
        self.assertEqual(payload["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(proc.returncode, 2)

    def test_apply_then_status_reports_installed(self) -> None:
        _, status = self.box.call_cli("status")
        revision = status["result"]["revision"]
        rc, env = self.box.call_cli("apply", {"expected_revision": revision, "activate": False})
        self.assertEqual((rc, env["ok"]), (0, True))
        self.assertGreaterEqual(env["result"]["file_operations"], 10)
        self.assertTrue((self.box.theme / "index.theme").exists())
        self.assertIn("Inherits=FixtureBase,hicolor",
                      (self.box.theme / "index.theme").read_text())
        rc, env = self.box.call_cli("status")
        self.assertTrue(env["result"]["installed"])
        self.assertFalse(env["result"]["stale"])
        # revert channel
        rc, env = self.box.call_cli("revert")
        self.assertEqual((rc, env["ok"]), (0, True))
        self.assertFalse(list(self.box.theme.rglob("*.png")))

    def test_preview_blocked_by_revert_journal(self) -> None:
        _, scan=self.box.call_cli('scan')
        group=scan['result']['groups'][0]
        (self.box.state/'revert-pending.json').write_text('{}')
        rc,envelope=self.box.call_cli('preview',{
            'icon_id':group['icon_id'],'source_sha256':group['source_sha256'],'size':48})
        self.assertEqual((rc,envelope['error']['code']),(5,'RECOVERY_REQUIRED'))


if __name__ == "__main__":
    unittest.main()
