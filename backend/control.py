#!/usr/bin/env python3
"""Installed entry shim: forwards to the icon_normalizer package next to it.

The systemd units and the extension spawn ``<libexec>/control.py``; keeping
this tiny wrapper stable decouples deployment paths from package internals.
"""
from __future__ import annotations

import sys
from pathlib import Path

_LIBEXEC = Path(__file__).resolve().parent
if str(_LIBEXEC) not in sys.path:
    sys.path.insert(0, str(_LIBEXEC))

from icon_normalizer.control import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
