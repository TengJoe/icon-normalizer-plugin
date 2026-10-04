#!/usr/bin/env python3
"""Standalone uninstaller — a thin wrapper over tools/install.py (ADR-0004 §3).

Keeps ``~/.local/state/icon-normalizer/backups`` so a later manual restore
remains possible.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from install import uninstall  # noqa: E402


def main() -> int:
    keep_backend = "--keep-backend" in sys.argv[1:]
    return uninstall(keep_backend)


if __name__ == "__main__":
    sys.exit(main())
