"""GSettings isolation layer.

The only module allowed to touch ``org.gnome.desktop.interface``. Everything is
injectable so tests (and fixture runs) can pass ``settings=None`` and avoid the
GObject runtime entirely.
"""
from __future__ import annotations

import subprocess
import hashlib
import json
from pathlib import Path
from typing import Any, Protocol

from .core.transaction import durable_unlink


class ThemeSettings(Protocol):
    """Minimal surface of Gio.Settings the backend relies on."""

    def get_string(self, key: str) -> str: ...

    def set_string(self, key: str, value: str) -> bool: ...


def load_interface_settings() -> ThemeSettings | None:
    """Return the real Gio.Settings for org.gnome.desktop.interface, or None."""
    try:
        import gi

        gi.require_version("Gtk", "3.0")  # keep the backend single-toolkit
        from gi.repository import Gio

        settings: ThemeSettings = Gio.Settings.new("org.gnome.desktop.interface")
        return settings
    except Exception:
        return None


def read_icon_theme_cli(timeout: float = 5.0) -> str | None:
    """Read the current icon theme via the gsettings CLI; None when unavailable."""
    try:
        out = subprocess.run(
            ["gsettings", "get", "org.gnome.desktop.interface", "icon-theme"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    value = out.stdout.strip()
    if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
        return value[1:-1]
    return value


def set_icon_theme(settings: ThemeSettings, theme: str) -> None:
    """Activate a theme with a synchronous read-back confirmation."""
    if not settings.set_string("icon-theme", theme):
        raise RuntimeError("GSettings refused theme activation")
    _sync(settings)
    if settings.get_string("icon-theme") != theme:
        raise RuntimeError("Theme activation was not confirmed")


def _sync(settings: ThemeSettings) -> None:
    try:
        from gi.repository import Gio

        Gio.Settings.sync()
    except Exception:
        pass


def current_icon_theme(settings: ThemeSettings | None) -> str | None:
    if settings is not None:
        try:
            return settings.get_string("icon-theme")
        except Exception:
            return None
    return read_icon_theme_cli()


def finish_pending_theme(
    settings: ThemeSettings | None, pending_path: Path, manifest_path: Path,
) -> None:
    """Finish activation or compensate an interrupted revert after file recovery.

    The log is removed only after synchronous theme read-back. A revert log
    binds both generations of the manifest, so recovery never guesses which
    filesystem generation survived a crash.
    """
    data = json.loads(pending_path.read_text())
    if data.get("stage") == "files_committed":
        target = data.get("activate_theme")
    elif data.get("stage") == "revert_prepared":
        digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest() \
            if manifest_path.exists() else None
        if digest == data.get("manifest_after_sha"):
            target = data.get("restore_theme")
        elif digest == data.get("manifest_before_sha"):
            target = data.get("previous_theme")
        else:
            raise RuntimeError("Manifest changed externally during theme recovery")
    else:
        raise RuntimeError("Unknown theme recovery journal stage")
    if not isinstance(target, str) or not target:
        raise RuntimeError("Invalid theme recovery target")
    if settings is None:
        raise RuntimeError("GSettings unavailable; theme recovery journal retained")
    guard = data.get("only_if_current_theme")
    if guard is not None:
        if not isinstance(guard, str) or not guard:
            raise RuntimeError("Invalid theme activation guard")
        if current_icon_theme(settings) not in (guard, target):
            # Files committed, but the user chose another theme after rendering.
            # The next maintenance run can migrate that latest selection.
            durable_unlink(pending_path)
            return
    set_icon_theme(settings, target)
    durable_unlink(pending_path)


def default_base_theme(settings: ThemeSettings | None) -> str:
    """Theme to inherit by default: the current one, then hicolor."""
    theme = current_icon_theme(settings)
    if theme and theme.strip() and theme != "DockNormalized":
        return theme
    return "hicolor"


def describe_settings(settings: Any) -> str:
    return type(settings).__name__ if settings is not None else "None"
