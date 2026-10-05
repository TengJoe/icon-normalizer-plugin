"""Installation layout — the single source of truth for every tool script.

``install.py`` / ``uninstall.py`` / ``build.py`` all derive their paths from
here so the three can never drift apart (ADR-0004 §1).
"""
from __future__ import annotations

import os
import ast
from dataclasses import dataclass
from pathlib import Path

EXTENSION_UUID = "icon-normalizer@joeydeng.local"
THEME_NAME = "DockNormalized"

# GNOME Extensions compiles `schemas/gschemas.compiled` itself for GNOME 45+
# packages (review rule EGO-P-006: unnecessary build artifacts must not ship),
# so the packaged ZIP omits it while `tools/install.py` recompiles it for
# local source installs. `build.py` and `release_audit.py` share this set so
# the archive comparison cannot drift from the packaging rule.
PACKAGE_EXCLUDE = frozenset({"schemas/gschemas.compiled"})
UNITS = ("icon-normalizer.service", "icon-normalizer.timer", "icon-normalizer.path")
TRIGGER_UNITS = ("icon-normalizer.timer", "icon-normalizer.path")

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def backend_version() -> str:
    """Read the backend version without importing Gtk or executing code."""
    tree = ast.parse((PROJECT_ROOT / "backend/icon_normalizer/version.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "BACKEND_VERSION"
                for target in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, str):
                return value
    raise RuntimeError("Backend version marker missing")


def home() -> Path:
    return Path(os.environ.get("HOME") or Path.home())


@dataclass(frozen=True)
class Layout:
    libexec: Path            # ~/.local/libexec/icon-normalizer
    extension: Path          # ~/.local/share/gnome-shell/extensions/<uuid>
    units: Path              # ~/.config/systemd/user
    state: Path              # ~/.local/state/icon-normalizer
    theme: Path              # ~/.local/share/icons/DockNormalized
    user_apps: Path          # ~/.local/share/applications
    preview_cache: Path      # ~/.cache/icon-normalizer/previews
    backups: Path            # ~/.local/state/icon-normalizer/backups

    @property
    def control_path(self) -> Path:
        return self.libexec / "control.py"


def resolve(root: Path | None = None) -> Layout:
    """Resolve the install layout, optionally rooted at a private test home."""
    base = (root or home()).absolute()
    state = base / ".local" / "state" / "icon-normalizer"
    return Layout(
        libexec=base / ".local" / "libexec" / "icon-normalizer",
        extension=base / ".local" / "share" / "gnome-shell" / "extensions" / EXTENSION_UUID,
        units=base / ".config" / "systemd" / "user",
        state=state,
        theme=base / ".local" / "share" / "icons" / THEME_NAME,
        user_apps=base / ".local" / "share" / "applications",
        preview_cache=base / ".cache" / "icon-normalizer" / "previews",
        backups=state / "backups",
    )
