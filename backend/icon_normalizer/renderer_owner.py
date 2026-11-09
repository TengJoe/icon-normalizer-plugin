"""Which renderer owns the theme directory.

The Shell extension renders icons in-process (ADR-0008). The Python worker
stays in the tree as the cross-implementation oracle, but two renderers
writing the same theme make each one rewrite every file the other produced:
the PNG bytes differ by a few levels per channel at anti-aliased edges, so
each writer sees foreign output and re-renders all managed files.

The in-process engine therefore claims ownership in ``renderer.json`` and the
Python write path refuses to run unless an operator explicitly asks for it
(parity runs, repair work) by setting ``ICON_NORMALIZER_ALLOW_FOREIGN_RENDER=1``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .errors import reject

MARKER_NAME = 'renderer.json'
ALLOW_ENV = 'ICON_NORMALIZER_ALLOW_FOREIGN_RENDER'
GJS_OWNER = 'gjs'


def marker_path(state: Path) -> Path:
    """Location of the ownership marker inside a state directory."""
    return Path(state) / MARKER_NAME


def owner(state: Path) -> str | None:
    """Recorded renderer owner, or None when nothing claimed the directory."""
    try:
        document: Any = json.loads(marker_path(state).read_text())
    except (OSError, ValueError):
        return None
    value = document.get("owner") if isinstance(document, dict) else None
    return value if isinstance(value, str) else None


def claim(state: Path, value: str) -> None:
    """Record an owner, atomically enough for a single small document."""
    path = marker_path(state)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"schema_version": 1, "owner": value}, indent=2))
    temporary.replace(path)


def guard(state: Path) -> None:
    """Refuse a Python write when the in-process engine owns the theme.

    ``scan``, ``status`` and ``preview`` stay available: they read, they do
    not rewrite the theme, and a repair workflow needs them.
    """
    recorded = owner(state)
    if recorded != GJS_OWNER or os.environ.get(ALLOW_ENV) == "1":
        return
    reject(
        "RENDERER_OWNED",
        "图标主题由扩展进程内引擎负责渲染；后台写入已停用以避免两套渲染器互相覆盖",
        retryable=False,
        details={"owner": recorded, "override_env": ALLOW_ENV},
    )
