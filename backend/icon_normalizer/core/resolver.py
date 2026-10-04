"""Gtk3 icon resolution and artwork loading — the backend's ONLY gateway to GI.

Hard invariant: this backend runs Gtk-3.0/GdkPixbuf-2.0 in its own process and
must never share a process with Gtk-4.0. ``require_gtk3_only()`` enforces that.
All ``Gtk.IconTheme`` lookups happen in the main thread (GTK3 is not thread
safe); GdkPixbuf file loading is thread safe and may run inside workers.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

_gtk_lock = threading.Lock()
_gtk_checked = False


class ToolkitCollision(RuntimeError):
    """A Gtk-4.0 typelib is already loaded in this (backend) process."""


def require_gtk3_only() -> None:
    """Load Gtk 3.0 or refuse to run; never allow a Gtk4/Gtk3 mixed process."""
    global _gtk_checked
    if _gtk_checked:
        return
    import gi

    if "Gtk" in sys.modules:
        loaded = getattr(sys.modules["Gtk"], "__version__", None)
        raise ToolkitCollision(f"Gtk already imported before require_gtk3_only(): {loaded}")
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk  # noqa: F401  (binding pinned to 3.0)

    major = getattr(Gtk, "get_major_version", lambda: 3)()
    if int(major) != 3:
        raise ToolkitCollision(f"Gtk major version {major} loaded; backend requires 3")
    _gtk_checked = True


def _gtk_icon_theme() -> Any:
    require_gtk3_only()
    from gi.repository import Gtk

    return Gtk


def pixbuf_to_image(pb: Any) -> Image.Image:
    """GdkPixbuf → PIL RGBA, tolerating missing trailing row padding."""
    width, height = pb.get_width(), pb.get_height()
    channels, rowstride = pb.get_n_channels(), pb.get_rowstride()
    raw = bytes(pb.get_pixels())
    rows: list[np.ndarray] = [
        np.frombuffer(raw[y * rowstride : y * rowstride + width * channels], dtype=np.uint8)
        .reshape(width, channels)
        for y in range(height)
    ]
    return Image.fromarray(np.stack(rows)).convert("RGBA")


class SourceMeta(dict[str, Any]):
    """Provenance metadata of a loaded source (dict for manifest round-trips)."""


def load_image(path: str | Path, vector_size: int = 1024) -> tuple[Image.Image, SourceMeta]:
    """Load raster or SVG artwork into a PIL RGBA image."""
    suffix = Path(path).suffix.lower()
    if suffix in {".svg", ".svgz"}:
        from gi.repository import GdkPixbuf

        pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), vector_size, vector_size, True)
        image = pixbuf_to_image(pb)
        return image, SourceMeta(
            kind="vector", native_px=None, rasterized_px=[pb.get_width(), pb.get_height()]
        )
    try:
        with Image.open(path) as opened:
            image = opened.convert("RGBA")
    except Exception:
        from gi.repository import GdkPixbuf

        image = pixbuf_to_image(GdkPixbuf.Pixbuf.new_from_file(str(path)))
    return image, SourceMeta(kind="raster", native_px=list(image.size), rasterized_px=None)


class IconResolver:
    """Theme-name → file resolution against the SOURCE theme (never the overlay)."""

    def __init__(
        self,
        base_theme: str,
        search_path: list[str] | None = None,
    ) -> None:
        Gtk = _gtk_icon_theme()
        self._theme = Gtk.IconTheme.new()
        if search_path:
            self._theme.set_search_path([str(p) for p in search_path])
        self._theme.set_custom_theme(base_theme)
        self.base_theme = base_theme

    def lookup(self, icon: str, size: int = 256) -> Path:
        with _gtk_lock:
            info = self._theme.lookup_icon(icon, size, 0)
            if not info or not info.get_filename():
                raise FileNotFoundError(f"No icon for {icon}")
            return Path(info.get_filename())

    def search_paths(self) -> list[str]:
        return [str(path) for path in self._theme.get_search_path()]


def resolve_source(
    icon: str,
    resolver: IconResolver | None = None,
    size: int = 256,
    forbidden_dir: Path | None = None,
) -> Path:
    """Resolve an icon reference to a concrete source file.

    Absolute references pass through; theme names go through ``resolver``.
    Anything inside the generated overlay is rejected as a source.
    """
    if Path(icon).is_absolute():
        path = Path(icon)
    else:
        if resolver is None:
            raise FileNotFoundError(f"No resolver for theme icon {icon}")
        path = resolver.lookup(icon, size)
    if not path.is_file():
        raise FileNotFoundError(str(path))
    if forbidden_dir is not None:
        if forbidden_dir.resolve() in path.resolve().parents:
            raise ValueError(f"Generated icon cannot be a source: {path}")
    return path


def lookup_size_specific(
    icon_name: str,
    size: int,
    base_theme: str,
    search_path: list[str] | None,
    exclude_dir: Path | None,
) -> Path | None:
    """Resolve the size-specific original artwork for preview slots."""
    try:
        resolver = IconResolver(base_theme=base_theme, search_path=search_path)
        hit = resolver.lookup(icon_name, size)
    except Exception:
        return None
    if exclude_dir is not None and str(exclude_dir) in str(hit):
        return None
    return hit
