"""icon_normalizer — GNOME application icon normalization backend package.

Gtk3/GdkPixbuf runs ONLY inside this package, in its own process; the GNOME
Shell frontend (Gtk4/Libadwaita) talks to it exclusively through the JSON CLI
protocol (see PROTOCOL.md).
"""
from __future__ import annotations

from .errors import ProtocolError
from .policy import Policy, PolicyDefaults, compute_revision
from .version import API_VERSION, BACKEND_VERSION, CORE_VERSION
from .xdg import RuntimePaths, from_environment

__all__ = [
    "API_VERSION",
    "BACKEND_VERSION",
    "CORE_VERSION",
    "Policy",
    "PolicyDefaults",
    "ProtocolError",
    "RuntimePaths",
    "compute_revision",
    "from_environment",
]
