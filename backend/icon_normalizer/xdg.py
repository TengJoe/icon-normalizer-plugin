"""Runtime path derivation.

Every path the backend touches is derived here from the running user's
environment at call time — nothing is captured at import time, which keeps the
package testable under sandboxed HOME/XDG variables and free of hardcoded
user-specific locations.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

THEME_NAME = "DockNormalized"

_ENV_STATE = "ICON_NORMALIZER_STATE"
_ENV_THEME = "ICON_NORMALIZER_THEME"
_ENV_USER_APPS = "ICON_NORMALIZER_USER_APPS"
_ENV_PREVIEW = "ICON_NORMALIZER_PREVIEW"


def _home() -> Path:
    return Path(os.environ.get("HOME") or Path.home())


def _xdg_data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or _home() / ".local" / "share")


def _xdg_cache_home() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME") or _home() / ".cache")


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value) if value else default


@dataclass(frozen=True)
class RuntimePaths:
    """Absolute locations the backend is allowed to read and write."""

    home: Path
    state_dir: Path
    theme_dir: Path
    theme_name: str
    user_applications: Path
    preview_root: Path
    libexec: Path

    @property
    def lock_path(self) -> Path:
        return self.state_dir / "sync.lock"

    @property
    def config_path(self) -> Path:
        return self.state_dir / "config.json"

    @property
    def user_rules_path(self) -> Path:
        return self.state_dir / "user-rules.json"

    @property
    def manifest_path(self) -> Path:
        return self.state_dir / "manifest.json"

    @property
    def pending_path(self) -> Path:
        return self.state_dir / "pending.json"

    @property
    def settings_pending_path(self) -> Path:
        return self.state_dir / "settings-pending.json"

    @property
    def revert_pending_path(self) -> Path:
        return self.state_dir / "revert-pending.json"

    @property
    def baseline_path(self) -> Path:
        return self.state_dir / "baseline.json"

    @property
    def last_run_path(self) -> Path:
        return self.state_dir / "last-run.json"

    @property
    def last_scan_path(self) -> Path:
        return self.state_dir / "last-scan.json"

    @property
    def last_error_path(self) -> Path:
        return self.state_dir / "last-error.json"

    @property
    def user_overrides_path(self) -> Path:
        """Optional user-local reviewed-classification file (machine-specific entries)."""
        return self.state_dir / "overrides.json"

    @property
    def backups_dir(self) -> Path:
        return self.state_dir / "backups"


def from_environment(libexec: Path | None = None) -> RuntimePaths:
    """Derive paths from the running user's environment.

    ``libexec`` defaults to the parent directory of the installed package, which
    matches the shipped layout (``~/.local/libexec/icon-normalizer/``).
    """
    resolved_libexec = (
        Path(libexec).resolve()
        if libexec is not None
        else Path(__file__).resolve().parent.parent
    )
    home = _home()
    return RuntimePaths(
        home=home,
        state_dir=_env_path(_ENV_STATE, home / ".local" / "state" / "icon-normalizer"),
        theme_dir=_env_path(_ENV_THEME, _xdg_data_home() / "icons" / THEME_NAME),
        theme_name=THEME_NAME,
        user_applications=_env_path(_ENV_USER_APPS, _xdg_data_home() / "applications"),
        preview_root=_env_path(_ENV_PREVIEW, _xdg_cache_home() / "icon-normalizer" / "previews"),
        libexec=resolved_libexec,
    )
