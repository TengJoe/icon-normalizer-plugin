"""Generated overlay theme management: index, ownership marker, icon cache.

The overlay theme is a plain fixed-size directory tree owned by this tool. The
ownership marker refuses to touch a directory the tool did not create, and the
icon cache is rebuilt through the system ``gtk-update-icon-cache`` binary
(located via PATH, never a hardcoded absolute path).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

MARKER = "icon-normalizer-owned-v1\n"
MARKER_FILE = ".icon-normalizer-owned"
MANIFEST_VERSION = 1


def theme_index(theme_name: str, base_theme: str, sizes: tuple[int, ...] | list[int]) -> bytes:
    """index.theme content: fixed-size Directories inheriting the source theme."""
    dirs = [f"{n}x{n}/apps" for n in sizes]
    text = (
        "[Icon Theme]\n"
        f"Name={theme_name}\n"
        "Comment=Normalized application artwork; original theme fallback\n"
        f"Inherits={base_theme},hicolor\n"
        f"Directories={','.join(dirs)}\n"
    )
    for n, d in zip(sizes, dirs):
        text += f"\n[{d}]\nSize={n}\nType=Fixed\nContext=Applications\n"
    return text.encode()


def write_marker(theme_dir: Path) -> bytes:
    return MARKER.encode()


class ThemeDirectory:
    """Filesystem view of the generated theme."""

    def __init__(self, theme_dir: Path, theme_name: str) -> None:
        self.dir = Path(theme_dir)
        self.name = theme_name

    def owned(self) -> bool:
        """False when absent; raise when present but not owned by this tool."""
        if not self.dir.exists():
            return False
        marker = self.dir / MARKER_FILE
        if not marker.is_file() or marker.read_text() != MARKER:
            raise ValueError("Generated theme exists but is not owned by this tool")
        return True

    def has_pngs(self) -> bool:
        return any(self.dir.glob("*x*/apps/*.png"))

    def cache_valid(self) -> bool:
        if not (self.dir / "index.theme").is_file():
            return False
        if not self.has_pngs():
            return not (self.dir / "icon-theme.cache").exists()
        binary = _cache_binary()
        if binary is None:
            return False
        result = subprocess.run(
            [binary, "--validate", str(self.dir)], capture_output=True, check=False
        )
        return result.returncode == 0

    def rebuild(self) -> None:
        if not self.has_pngs():
            cache = self.dir / "icon-theme.cache"
            if cache.exists():
                cache.unlink()
            return
        binary = _cache_binary()
        if binary is None:
            raise RuntimeError("gtk-update-icon-cache not found on PATH")
        result = subprocess.run(
            [binary, "--force", "--quiet", str(self.dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode or not self.cache_valid():
            raise RuntimeError("Icon cache rebuild failed: " + result.stderr.strip())


def _cache_binary() -> str | None:
    return shutil.which("gtk-update-icon-cache") or (
        "/usr/bin/gtk-update-icon-cache" if Path("/usr/bin/gtk-update-icon-cache").exists() else None
    )
