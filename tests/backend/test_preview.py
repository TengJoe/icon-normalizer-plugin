"""Preview protocol tests: identity, staleness, cache, apply-pixel parity."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.config_store import ConfigStore, PolicyDefaults  # noqa: E402
from icon_normalizer.core.analyzer import analyze  # noqa: E402
from icon_normalizer.core.engine import Engine, EngineConfig  # noqa: E402
from icon_normalizer.core.renderer import normalize  # noqa: E402
from icon_normalizer.core.resolver import load_image  # noqa: E402
from icon_normalizer.errors import ProtocolError  # noqa: E402
from icon_normalizer.preview import preview  # noqa: E402
from icon_normalizer.xdg import RuntimePaths  # noqa: E402

from harness import Sandbox, make_desktop  # noqa: E402


class PreviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("fixture-small", 198)   # enlarge
        self.box.base_icon("fixture-keep", 224)    # within deadband
        make_desktop(self.box.system_apps / "small.desktop", "Small", "fixture-small")
        make_desktop(self.box.system_apps / "keep.desktop", "Keep", "fixture-keep")
        # produce a scan snapshot via the real engine (read-only path)
        engine = self._engine()
        engine.sync(apply=False)
        self._write_last_scan()

    def _paths(self) -> RuntimePaths:
        return RuntimePaths(
            home=self.box.home,
            state_dir=self.box.state,
            theme_dir=self.box.theme,
            theme_name="DockNormalized",
            user_applications=self.box.apps,
            preview_root=self.box.preview,
            libexec=Path(__file__).resolve().parents[2] / "backend",
        )

    def _engine(self) -> Engine:
        store = ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase"))
        policy = store.load_policy()
        return Engine(EngineConfig(
            home=self.box.home,
            theme_dir=self.box.theme,
            theme_name="DockNormalized",
            state_dir=self.box.state,
            user_applications=self.box.apps,
            desktop="GNOME",
            policy=policy,
            overrides={},
            user_rules=dict(store.load_rules().get("icons", {})),
            application_dirs=(str(self.box.apps), str(self.box.system_apps)),
            icon_search_path=(str(self.box.home / ".local/share/icons"),
                              str(self.box.share / "icons")),
            settings=None,
        ))

    def _write_last_scan(self) -> None:
        """Mirror control.op_scan's last-scan.json payload for identity checks."""
        from icon_normalizer.control import _rows_to_groups

        engine = self._engine()
        result = engine.sync(apply=False)
        rules = {}
        groups = _rows_to_groups(result["apps"], rules)
        payload = {"revision": "0" * 64, "groups": groups, "summary": result["summary"]}
        self.box.state.mkdir(parents=True, exist_ok=True)
        (self.box.state / "last-scan.json").write_text(json.dumps(payload))

    def _group(self, icon_name: str) -> dict:
        scan = json.loads((self.box.state / "last-scan.json").read_text())
        for group in scan["groups"]:
            if group["icon_name"] == icon_name:
                return group
        raise AssertionError(f"group {icon_name} not found")

    def _preview(self, group: dict, size: int) -> dict:
        store = ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase"))
        return preview(
            {"icon_id": group["icon_id"], "source_sha256": group["source_sha256"],
             "size": size},
            paths=self._paths(),
            store=store,
            policy=store.load_policy(),
            revision="0" * 64,
        )

    def test_preview_matches_apply_pixels(self) -> None:
        group = self._group("fixture-small")
        for size in (16, 48, 128):
            result = self._preview(group, size)
            original = load_image(str(group["source_path"]))[0]
            st = analyze(original)
            reference, _info = normalize(original, st, "plate-rect", size, 0.88, 0.72)
            import base64
            import io

            buf = io.BytesIO()
            reference.save(buf, format="PNG")
            self.assertEqual(
                base64.b64decode(result["proposed_png_base64"]), buf.getvalue()
            )

    def test_preview_never_touches_production_state(self) -> None:
        engine = self._engine()
        engine.sync(apply=True)
        before = {
            "config": (self.box.state / "config.json").read_bytes(),
            "manifest": (self.box.state / "manifest.json").read_bytes(),
            "baseline": (self.box.state / "baseline.json").read_bytes(),
            "last_run": (self.box.state / "last-run.json").read_bytes(),
            "pngs": sorted(p.name for p in self.box.theme.rglob("*.png")),
        }
        for group_name in ("fixture-small", "fixture-keep"):
            group = self._group(group_name)
            for size in (16, 48, 256):
                self._preview(group, size)
        after = {
            "config": (self.box.state / "config.json").read_bytes(),
            "manifest": (self.box.state / "manifest.json").read_bytes(),
            "baseline": (self.box.state / "baseline.json").read_bytes(),
            "last_run": (self.box.state / "last-run.json").read_bytes(),
            "pngs": sorted(p.name for p in self.box.theme.rglob("*.png")),
        }
        self.assertEqual(before, after)

    def test_keep_uses_size_specific_original(self) -> None:
        group = self._group("fixture-keep")
        for size in (16, 48, 256):
            result = self._preview(group, size)
            self.assertIn("note", result["metrics"])
            self.assertGreater(
                self._opaque_core_ratio(result["original_png_base64"], size), 0.55
            )

    def test_stale_source_rejected(self) -> None:
        group = self._group("fixture-small")
        with self.assertRaises(ProtocolError) as ctx:
            preview(
                {"icon_id": group["icon_id"], "source_sha256": "f" * 64, "size": 48},
                paths=self._paths(),
                store=ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase")),
                policy=ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase")).load_policy(),
                revision="0" * 64,
            )
        self.assertEqual(ctx.exception.code, "STALE_SOURCE")

    def test_unknown_icon_rejected(self) -> None:
        with self.assertRaises(ProtocolError) as ctx:
            preview(
                {"icon_id": "e" * 64, "source_sha256": "a" * 64, "size": 48},
                paths=self._paths(),
                store=ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase")),
                policy=ConfigStore(self.box.state, PolicyDefaults(base_theme="FixtureBase")).load_policy(),
                revision="0" * 64,
            )
        self.assertEqual(ctx.exception.code, "NOT_FOUND")

    def test_cache_hit_and_lru_budget(self) -> None:
        group = self._group("fixture-small")
        first = self._preview(group, 48)
        cache_files = list(self.box.preview.glob("*.png"))
        self.assertEqual(len(cache_files), 1)
        second = self._preview(group, 48)
        self.assertEqual(first["proposed_png_base64"], second["proposed_png_base64"])
        self.assertLessEqual(
            max(f.stat().st_size for f in cache_files), 2 * 1024 * 1024
        )

    def _opaque_core_ratio(self, b64: str, size: int) -> float:
        import base64
        import io

        from PIL import Image

        image = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")
        import numpy as np

        alpha = np.asarray(image)[:, :, 3]
        ys, xs = np.where(alpha > 200)
        canvas = max(image.size)
        return max(xs.max() - xs.min(), ys.max() - ys.min()) / canvas


if __name__ == "__main__":
    unittest.main()
