"""Theme-follow preference and migration plan. Caller owns sync.lock."""
from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from .core.transaction import atomic_write, safe_path
from .errors import reject
from .policy import Policy

_NAME = re.compile(r"[\w .+\-]+", re.UNICODE)


def enabled(state: Path) -> bool:
    path = safe_path(state / "theme-follow.json")
    if not path.exists():
        return True
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        reject("INVALID_CONFIG", f"theme-follow.json unreadable: {exc}")
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("enabled"), bool):
        reject("INVALID_CONFIG", "theme-follow.json invalid")
    return bool(data["enabled"])


def set_enabled(state: Path, value: bool) -> None:
    document = {"schema_version": 1, "enabled": value}
    atomic_write(state / "theme-follow.json", json.dumps(document, indent=2).encode(), 0o600)


def transition_policy(policy: Policy, theme: str, search_paths: list[str]) -> Policy:
    if not theme or len(theme) > 128 or theme in (".", "..") or not _NAME.fullmatch(theme):
        reject("INVALID_CONFIG", "selected icon theme has an unsafe name")
    installed = any((Path(root) / theme / "index.theme").is_file() for root in search_paths)
    if not installed:
        reject("SOURCE_UNAVAILABLE", "selected icon theme is not installed")
    return replace(policy, base_theme=theme)


def baseline_document(path: Path, policy: Policy, theme: str) -> dict[str, Any]:
    if not path.exists():
        return {"icon_theme": theme, "config": {"policy": policy.to_dict()}}
    try:
        baseline = json.loads(path.read_text())
    except (ValueError, OSError):
        reject("RECOVERY_REQUIRED", "restore baseline unreadable; theme migration refused")
    if not isinstance(baseline, dict) or not isinstance(baseline.get("config"), dict):
        reject("RECOVERY_REQUIRED", "restore baseline invalid; theme migration refused")
    baseline["icon_theme"] = theme
    baseline["config"]["policy"] = policy.to_dict()
    return baseline
