"""Cheap presence probes for status; explicit runtime checks for image operations."""
from __future__ import annotations

import importlib
import importlib.util
from typing import Any

from .errors import reject

MODULES = {"pillow": "PIL", "numpy": "numpy", "gtk3": "gi"}


def missing_modules() -> list[str]:
    missing = []
    for label, module in MODULES.items():
        try:
            present = importlib.util.find_spec(module) is not None
        except ModuleNotFoundError as exc:
            if exc.name != module:
                raise
            present = False
        if not present:
            missing.append(label)
    return missing


def require_image_runtime() -> None:
    for module in ("PIL.Image", "numpy", "gi"):
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as exc:
            if not exc.name or not any(exc.name == root or exc.name.startswith(root + ".")
                                       for root in MODULES.values()):
                raise
            reject("DEPENDENCY_MISSING", f"Missing image dependency: {exc.name}",
                   details={"module": exc.name})
    gi: Any = importlib.import_module("gi")
    for namespace, version in (("Gtk", "3.0"), ("GdkPixbuf", "2.0")):
        try:
            gi.require_version(namespace, version)
        except ValueError as exc:
            if "not available" not in str(exc):
                raise
            reject("DEPENDENCY_MISSING", f"Missing typelib: {namespace} {version}",
                   details={"namespace": namespace, "version": version})
