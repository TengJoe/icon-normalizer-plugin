"""Shared sandbox harness: a private fixture home with a synthetic icon theme.

Mirrors the validated lifecycle fixture: a ``FixtureBase`` theme with known
artwork, desktop entries in user/system application dirs, and a fully
sandboxed path environment. Tests never touch the real user state.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from isolation import isolated_env
SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]

INDEX_THEME = (
    "[Icon Theme]\n"
    "Name=FixtureBase\n"
    "Comment=fixture\n"
    "Directories=256x256/apps\n"
    "\n[256x256/apps]\nSize=256\nType=Fixed\nContext=Applications\n"
)


def make_icon(path: Path, extent: int, color: str = "red") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGBA", (256, 256))
    off = (256 - extent) // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (off, off, off + extent - 1, off + extent - 1), radius=20, fill=color
    )
    image.save(path)


def make_desktop(path: Path, name: str, icon: str, extra: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "[Desktop Entry]\n"
        f"Type=Application\nName={name}\nIcon={icon}\nExec=/usr/bin/true\n"
        + extra
        + "\n[Desktop Action Extra]\nIcon=action-untouched\nExec=/usr/bin/true\n"
    )


def png_hashes(root: Path) -> dict[str, str]:
    return {
        str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(root.rglob("*.png"))
    }


class Sandbox:
    """A disposable HOME-equivalent tree plus engine/CLI helpers."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="icon-normalizer-test-")
        root = Path(self._tmp.name)
        self.root = root
        self.home = root / "home"
        self.share = root / "system" / "share"
        self.apps = self.home / ".local" / "share" / "applications"
        self.system_apps = self.share / "applications"
        self.base = self.share / "icons" / "FixtureBase"
        self.base.mkdir(parents=True)
        (self.base / "index.theme").write_text(INDEX_THEME)
        self.state = self.home / ".local" / "state" / "icon-normalizer"
        self.theme = self.home / ".local" / "share" / "icons" / "DockNormalized"
        self.preview = root / "preview"
        self.config_path = self.state / "config.json"
        self.write_config()

    def close(self) -> None:
        self._tmp.cleanup()

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ---------- fixture helpers ----------
    def base_icon(self, name: str, extent: int, color: str = "red") -> Path:
        path = self.base / "256x256" / "apps" / f"{name}.png"
        make_icon(path, extent, color)
        return path

    def write_config(self, **overrides: Any) -> None:
        config = {
            "schema_version": 2,
            "target": 0.88,
            "deadband": 0.02,
            "inner": 0.72,
            "sizes": SIZES,
            "base_theme": "FixtureBase",
        }
        config.update(overrides)
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(json.dumps(config))

    def write_rules(self, icons: dict[str, Any]) -> None:
        path = self.state / "user-rules.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schema_version": 1, "icons": icons}))

    def rules(self) -> dict[str, Any]:
        path = self.state / "user-rules.json"
        return json.loads(path.read_text()) if path.exists() else {"schema_version": 1, "icons": {}}

    def env(self) -> dict[str, str]:
        env = isolated_env(self.root)
        env.update({
            "HOME": str(self.home),
            "ICON_NORMALIZER_STATE": str(self.state),
            "ICON_NORMALIZER_THEME": str(self.theme),
            "ICON_NORMALIZER_USER_APPS": str(self.apps),
            "ICON_NORMALIZER_APPLICATION_DIRS": f"{self.apps}:{self.system_apps}",
            "ICON_NORMALIZER_ICON_SEARCH_PATH": (
                f"{self.home / '.local/share/icons'}:{self.share / 'icons'}"
            ),
            "ICON_NORMALIZER_PREVIEW": str(self.preview),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(BACKEND_DIR),
        })
        env.pop("XDG_DATA_HOME", None)
        env.pop("XDG_DATA_DIRS", None)
        return env

    # ---------- in-process engine ----------
    def build_engine(self, settings: Any = None) -> Any:
        from icon_normalizer.config_store import ConfigStore, PolicyDefaults
        from icon_normalizer.core.engine import Engine, EngineConfig
        from icon_normalizer.policy import Policy

        store = ConfigStore(self.state, PolicyDefaults(base_theme="FixtureBase"))
        policy = store.load_policy()
        config = EngineConfig(
            home=self.home,
            theme_dir=self.theme,
            theme_name="DockNormalized",
            state_dir=self.state,
            user_applications=self.apps,
            desktop="GNOME",
            policy=policy,
            overrides={},
            user_rules=dict(store.load_rules().get("icons", {})),
            application_dirs=(str(self.apps), str(self.system_apps)),
            icon_search_path=(str(self.home / ".local/share/icons"), str(self.share / "icons")),
            settings=settings,
        )
        return Engine(config)

    # ---------- CLI ----------
    def call_cli(
        self, operation: str, arguments: dict[str, Any] | None = None, request_id: str = "test"
    ) -> tuple[int, dict[str, Any]]:
        request = {
            "api_version": 1,
            "request_id": request_id,
            "operation": operation,
            "arguments": arguments or {},
        }
        proc = subprocess.run(
            [sys.executable, "-m", "icon_normalizer", "--json"],
            input=json.dumps(request).encode(),
            capture_output=True,
            env=self.env(),
            timeout=180,
            check=False,
        )
        try:
            envelope = json.loads(proc.stdout.decode())
        except Exception:
            envelope = {
                "ok": False,
                "error": {"code": "NO_STDOUT", "message": proc.stdout.decode()[:200] + proc.stderr.decode()[:200]},
            }
        return proc.returncode, envelope
