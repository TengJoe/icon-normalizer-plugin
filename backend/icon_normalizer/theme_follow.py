"""Theme-follow preference and migration plan. Caller owns sync.lock."""
from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Sequence

from .core.transaction import atomic_write, safe_path
from .errors import reject
from .policy import Policy

_NAME = re.compile(r"[\w .+\-]+", re.UNICODE)
_DARK_SUFFIX_PATTERN = re.compile(r"^(.*?)([-_])(dark|black)$", re.IGNORECASE)
_LIGHT_SUFFIX_PATTERN = re.compile(r"^(.*?)([-_])(light|white)$", re.IGNORECASE)
YARU_ACCENTS = {
    "blue": "blue", "teal": "prussiangreen", "green": "olive", "yellow": "yellow",
    "orange": "", "red": "red", "pink": "magenta", "purple": "purple",
    "slate": "sage", "brown": "wartybrown",
}


def resolve_system_variant(base_theme: str, prefer_dark: bool, accent: str,
                           search_paths: Sequence[Path | str]) -> str:
    """Follow GNOME accents only within the installed, standard Yaru family.

    Other icon families retain their chosen color and use sibling light/dark
    resolution. A missing accent variant never switches to an unrelated theme.
    """
    stem, _, _ = parse_theme_variant(base_theme)
    yaru_names = {"Yaru"} | {f"Yaru-{value}" for value in YARU_ACCENTS.values() if value}
    if stem in yaru_names and accent in YARU_ACCENTS:
        color = YARU_ACCENTS[accent]
        target = f"Yaru{'-' + color if color else ''}{'-dark' if prefer_dark else ''}"
        if any((Path(root) / target / "index.theme").is_file() for root in search_paths):
            return target
    return resolve_variant(base_theme, prefer_dark, search_paths)


def parse_theme_variant(theme_name: str) -> tuple[str, str | None, str | None]:
    """Parse a theme name into (stem, separator, variant_type).
    variant_type is 'dark', 'light', or None.
    """
    m_dark = _DARK_SUFFIX_PATTERN.match(theme_name)
    if m_dark:
        return m_dark.group(1), m_dark.group(2), "dark"
    m_light = _LIGHT_SUFFIX_PATTERN.match(theme_name)
    if m_light:
        return m_light.group(1), m_light.group(2), "light"
    return theme_name, None, None


def resolve_variant(
    base_theme: str,
    prefer_dark: bool,
    search_paths: Sequence[Path | str],
    is_installed_fn: Callable[[str], bool] | None = None,
) -> str:
    """Find the best matching sibling theme for the given color scheme preference.

    If the theme does not have a matching sibling (e.g. single theme like Adwaita),
    or if the candidate theme is not installed on disk, returns the original base_theme.
    """
    if not base_theme:
        return base_theme

    if is_installed_fn is None:
        def is_installed_fn(name: str) -> bool:
            return any((Path(root) / name / "index.theme").is_file() for root in search_paths)

    stem, sep, variant = parse_theme_variant(base_theme)
    sep = sep or "-"

    if prefer_dark:
        if variant == "dark":
            return base_theme
        candidates = [
            f"{stem}{sep}dark",
            f"{stem}{sep}Dark",
            f"{stem}{sep}DARK",
            f"{stem}_dark",
            f"{stem}_Dark",
            f"{stem}-dark",
            f"{stem}-Dark",
        ]
    else:
        if variant == "light":
            return base_theme
        candidates = [
            stem,
            f"{stem}{sep}light",
            f"{stem}{sep}Light",
            f"{stem}{sep}LIGHT",
            f"{stem}_light",
            f"{stem}_Light",
            f"{stem}-light",
            f"{stem}-Light",
        ]

    seen = set()
    deduped = []
    for c in candidates:
        if c != base_theme and c not in seen:
            seen.add(c)
            deduped.append(c)

    for candidate in deduped:
        if is_installed_fn(candidate):
            return candidate

    return base_theme


def enabled(state: Path) -> bool:
    details = {"reason": "PERSISTED_CONFIG_INVALID", "file": "theme-follow.json"}
    try:
        path = safe_path(state / "theme-follow.json")
        if not path.exists():
            return True
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        reject("INVALID_CONFIG", f"theme-follow.json unreadable: {exc}", details=details)
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("enabled"), bool):
        reject("INVALID_CONFIG", "theme-follow.json invalid", details=details)
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
