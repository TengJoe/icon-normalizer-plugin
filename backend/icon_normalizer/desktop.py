"""Desktop entry scanning, visibility rules and surgical ``Icon=`` rewriting.

Scanning is read-only and shared by dry-runs and applies. The ``Icon=`` rewrite
is deliberately surgical: only the main ``[Desktop Entry]`` section changes;
desktop actions, locale keys, ``Exec`` and byte formatting are preserved.
"""
from __future__ import annotations

import configparser
import os
import re
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

#: Maps a previous desktop entry back to its source state before re-planning.
EntryTransform = Callable[[Path, dict[str, str]], "dict[str, str] | None"]

_FLATPAK_EXPORTS = (
    "/var/lib/flatpak/exports/share",
)
_SNAP_DESKTOP = "/var/lib/snapd/desktop"


def application_roots(
    home: Path,
    data_dirs: str | None = None,
    extra_dirs: Iterable[Path] | None = None,
) -> list[Path]:
    """XDG application directories in shadowing order (first hit wins).

    ``data_dirs`` defaults to ``$XDG_DATA_DIRS``; flatpak exports and the snap
    desktop directory are appended as the desktop stack does.
    """
    data_home = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
    dirs: list[Path] = [data_home]
    dir_source = data_dirs if data_dirs is not None else "/usr/local/share:/usr/share"
    dirs += [Path(p) for p in dir_source.split(":") if p]
    dirs += [home / ".local" / "share" / "flatpak" / "exports" / "share"]
    dirs += [Path(p) for p in _FLATPAK_EXPORTS]
    dirs.append(Path(_SNAP_DESKTOP))
    if extra_dirs:
        dirs += [Path(p) for p in extra_dirs]
    unique: list[Path] = []
    for d in dirs:
        if d not in unique:
            unique.append(d)
    return [d / "applications" for d in unique]


def entry_visibility(entry: dict[str, str], desktop: str) -> str:
    """Classify a desktop entry for the current desktop; '' means visible."""
    if entry.get("Hidden", "false").lower() == "true":
        return "hidden"
    if entry.get("NoDisplay", "false").lower() == "true":
        return "no_display"
    active = set(desktop.split(":"))
    only = set(filter(None, entry.get("OnlyShowIn", "").split(";")))
    deny = set(filter(None, entry.get("NotShowIn", "").split(";")))
    if only and not (active & only):
        return "only_show_in_other_desktop"
    if active & deny:
        return "not_show_in_current_desktop"
    try_exec = entry.get("TryExec")
    if try_exec and not shutil.which(try_exec):
        return "tryexec_missing"
    # Check command presence without executing it. D-Bus activatable entries may omit Exec.
    try:
        argv = shlex.split(entry.get("Exec", ""))
    except ValueError:
        return "invalid_exec"
    if argv and not shutil.which(argv[0]):
        return "exec_missing"
    if not argv and entry.get("DBusActivatable", "false").lower() != "true":
        return "exec_missing"
    return "visible"


def read_desktop_section(data: bytes) -> dict[str, str]:
    """Parse the main ``[Desktop Entry]`` section of a .desktop byte blob."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str  # type: ignore[assignment]
    parser.read_string(data.decode("utf-8"))
    return dict(parser["Desktop Entry"])


def rewrite_icon_line(data: bytes, icon: str) -> bytes:
    """Replace the main ``Icon=`` only; retain actions, locales, Exec, formatting."""
    if "\n" in icon or "\r" in icon:
        raise ValueError("Invalid icon field")
    text = data.decode("utf-8")
    lines = text.splitlines(keepends=True)
    main = False
    found = False
    for i, line in enumerate(lines):
        if line.strip().startswith("["):
            main = line.strip() == "[Desktop Entry]"
        elif main and re.match(r"^Icon\s*=", line):
            end = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            lines[i] = "Icon=" + icon + end
            found = True
    if not found:
        raise ValueError("Main desktop section has no Icon=")
    return "".join(lines).encode("utf-8")


@dataclass
class ScanCounters:
    effective_entries: int = 0
    shadowed_entries: int = 0
    not_application: int = 0
    hidden: int = 0
    no_display: int = 0
    only_show_in_other_desktop: int = 0
    not_show_in_current_desktop: int = 0
    tryexec_missing: int = 0
    invalid_exec: int = 0
    exec_missing: int = 0
    missing_icon_field: int = 0
    visible: int = 0

    def as_dict(self) -> dict[str, int]:
        return {k: v for k, v in self.__dict__.items() if v}


@dataclass
class DesktopRef:
    desktop_id: str
    desktop_path: str
    name: str
    visibility: str


class DesktopScanError(ValueError):
    """One or more desktop files could not be parsed."""


def collect_desktop_entries(
    desktop: str,
    home: Path,
    entry_transform: EntryTransform | None = None,
    application_dirs: list[str] | None = None,
    data_dirs: str | None = None,
) -> tuple[dict[str, list[DesktopRef]], dict[str, int], list[dict[str, str]]]:
    """Group visible desktop entries by their ``Icon`` value.

    Returns ``(grouped, counts, errors)``. A user entry — including one carrying
    ``Hidden=true`` — masks the same system-wide entry id.
    """
    roots = (
        [Path(p) for p in application_dirs]
        if application_dirs is not None
        else application_roots(home, data_dirs=data_dirs)
    )
    seen: set[str] = set()
    grouped: dict[str, list[DesktopRef]] = {}
    counts = ScanCounters()
    errors: list[dict[str, str]] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.desktop")):
            app_id = str(path.relative_to(root)).replace("/", "-")
            if app_id in seen:
                counts.shadowed_entries += 1
                continue
            seen.add(app_id)
            counts.effective_entries += 1
            parser = configparser.ConfigParser(interpolation=None, strict=False)
            parser.optionxform = str  # type: ignore[assignment]
            try:
                parser.read(path, encoding="utf-8")
                entry = dict(parser["Desktop Entry"])
            except Exception as exc:
                errors.append({"desktop_path": str(path), "error": str(exc)})
                continue
            if entry_transform is not None:
                transformed = entry_transform(path, entry)
                if transformed is None:
                    continue
                entry = transformed
            if entry.get("Type") != "Application":
                counts.not_application += 1
                continue
            status = entry_visibility(entry, desktop)
            setattr(counts, status, getattr(counts, status) + 1)
            if status in ("hidden", "no_display"):
                continue
            icon = entry.get("Icon", "").strip()
            if not icon:
                counts.missing_icon_field += 1
                continue
            ref = DesktopRef(
                desktop_id=app_id,
                desktop_path=str(path),
                name=entry.get("Name", app_id),
                visibility=status,
            )
            grouped.setdefault(icon, []).append(ref)
    return grouped, counts.as_dict(), errors
