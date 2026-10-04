"""Rendering pipeline: squircle plates, adaptive contrast, shadow decay.

Pure functions: images and metrics in, images and render metadata out. The
measure-correct loop in :func:`normalize` always resamples from the original
crop (never from an already-resampled candidate), which keeps multi-size output
faithful to the source instead of accumulating resampling error.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

from .analyzer import IconMetrics, analyze

#: Squircle exponent (n=4) and the shadow strength used behind glyph plates.
SQUIRCLE_EXPONENT = 4
SHADOW_ALPHA = 0.28


@dataclass(frozen=True)
class RenderInfo:
    """Metadata of one rendered candidate; key set frozen (persisted)."""

    plate_color: str | None
    shadow_clamped: bool
    effective_scale_native: float
    crop_bbox: tuple[int, int, int, int]
    placement: tuple[int, int]
    content_core_pixels: int
    desired_content_core_pixels: int
    pixel_target_error: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "plate_color": self.plate_color,
            "shadow_clamped": self.shadow_clamped,
            "effective_scale_native": self.effective_scale_native,
            "crop_bbox": list(self.crop_bbox),
            "placement": list(self.placement),
            "content_core_pixels": self.content_core_pixels,
            "desired_content_core_pixels": self.desired_content_core_pixels,
            "pixel_target_error": self.pixel_target_error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RenderInfo":
        return cls(
            plate_color=data.get("plate_color"),
            shadow_clamped=bool(data.get("shadow_clamped", False)),
            effective_scale_native=float(data.get("effective_scale_native", 0.0)),
            crop_bbox=tuple(data.get("crop_bbox", (0, 0, 0, 0))),
            placement=tuple(data.get("placement", (0, 0))),
            content_core_pixels=int(data.get("content_core_pixels", 0)),
            desired_content_core_pixels=int(data.get("desired_content_core_pixels", 0)),
            pixel_target_error=int(data.get("pixel_target_error", 0)),
        )


def fit_original(img: Image.Image, size: int) -> Image.Image:
    """Center-fit the source into a transparent square canvas."""
    out = Image.new("RGBA", (size, size))
    scale = size / max(img.size)
    width_height = tuple(max(1, round(v * scale)) for v in img.size)
    picture = img if img.size == width_height else img.resize(width_height, Image.Resampling.LANCZOS)
    out.alpha_composite(picture, ((size - width_height[0]) // 2, (size - width_height[1]) // 2))
    return out


def superellipse_mask(size: int, exponent: int = SQUIRCLE_EXPONENT) -> Image.Image:
    """Anti-aliased squircle alpha mask.

    Supersampling gives smooth edges at small output sizes; exponent 4 is a
    squircle, exponent 5 approaches a circle while keeping flat sides.
    """
    res = max(size * 4, 256)
    yy, xx = np.mgrid[:res, :res]
    mask = (
        (abs((xx + 0.5 - res / 2) / (res / 2)) ** exponent)
        + (abs((yy + 0.5 - res / 2) / (res / 2)) ** exponent)
        <= 1
    )
    return Image.fromarray(mask.astype("uint8") * 255).resize(
        (size, size), Image.Resampling.LANCZOS
    )


def make_plate(size: int, glyph: Image.Image) -> tuple[Image.Image, str]:
    """Frosted squircle plate whose tone adapts to the glyph's luminance.

    Light glyphs sit on a dark plate, dark glyphs on a light plate; the tint is
    an alpha-weighted Rec.709 luminance decision at the 0.55 threshold.
    """
    arr = np.asarray(glyph).astype(float) / 255
    weights = arr[:, :, 3]
    lum = (arr[:, :, :3] @ np.array([0.2126, 0.7152, 0.0722]) * weights).sum() / max(
        weights.sum(), 1
    )
    dark = lum > 0.55
    top, bottom = ((58, 58, 62), (32, 32, 36)) if dark else ((248, 248, 250), (228, 228, 232))
    data = np.zeros((size, size, 4), dtype=np.uint8)
    for y in range(size):
        t = y / max(size - 1, 1)
        data[y, :, :3] = [round(top[c] + (bottom[c] - top[c]) * t) for c in range(3)]
    data[:, :, 3] = np.asarray(superellipse_mask(size))
    return Image.fromarray(data), ("dark" if dark else "light")


def normalize(
    img: Image.Image,
    metrics: IconMetrics,
    cls: str,
    size: int = 256,
    target: float = 0.88,
    inner: float = 0.72,
) -> tuple[Image.Image, RenderInfo]:
    """Render one normalized candidate of ``size`` pixels.

    The core is scaled to ``target`` (or ``target*inner`` for glyph plates); the
    full shadow extent is clamped to stay inside the canvas; glyphs get a soft
    drop shadow behind an adaptive squircle plate.
    """
    out = Image.new("RGBA", (size, size))
    core = metrics.core_bbox
    full = metrics.full_bbox
    extent = max(core[2] - core[0], core[3] - core[1])
    target_px = round(size * target)
    scale = (round(target_px * inner) if cls == "glyph" else target_px) / extent
    # Keep the complete meaningful shadow within the canvas while centering the core.
    half_extent = max(
        metrics.cx - full[0], full[2] - metrics.cx, metrics.cy - full[1], full[3] - metrics.cy
    )
    safe = (size / 2 - 0.5) / half_extent
    clamped = scale > safe
    scale = min(scale, safe)
    plate_kind: str | None = None
    if cls == "glyph":
        plate, plate_kind = make_plate(target_px, img)
        origin = (size - target_px) // 2
        shadow = Image.new("RGBA", (size, size))
        alpha = Image.new("L", (size, size))
        alpha.paste(
            superellipse_mask(target_px), (origin, origin + max(1, round(size * 0.01)))
        )
        shadow.putalpha(
            alpha.point(lambda v: round(v * SHADOW_ALPHA)).filter(
                ImageFilter.GaussianBlur(max(0.5, size * 0.012))
            )
        )
        out.alpha_composite(shadow)
        out.alpha_composite(plate, (origin, origin))
    crop = img.crop(full)
    desired = round(target_px * inner) if cls == "glyph" else target_px
    best: tuple[int, Image.Image, float, tuple[int, int], int] | None = None
    # Quantized alpha edges can lose a pixel after downsampling; each trial
    # samples the original source, never an already-resampled candidate.
    for _ in range(4):
        width_height = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
        scaled = crop.resize(width_height, Image.Resampling.LANCZOS)
        offset = (
            round(size / 2 - (metrics.cx - full[0]) * scale),
            round(size / 2 - (metrics.cy - full[1]) * scale),
        )
        layer = Image.new("RGBA", (size, size))
        layer.alpha_composite(scaled, offset)
        try:
            measured = round(analyze(layer).source_ratio * size)
        except Exception:
            measured = 0
        error = abs(measured - desired)
        if best is None or error < best[0]:
            best = (error, layer, scale, offset, measured)
        if error == 0 or measured == 0:
            break
        proposed = min(scale * desired / measured, safe)
        if abs(proposed - scale) < 1e-12:
            break
        scale = proposed
    assert best is not None
    _, layer, final_scale, offset, measured = best
    out.alpha_composite(layer)
    return out, RenderInfo(
        plate_color=plate_kind,
        shadow_clamped=clamped,
        effective_scale_native=final_scale,
        crop_bbox=full,
        placement=offset,
        content_core_pixels=measured,
        desired_content_core_pixels=desired,
        pixel_target_error=measured - desired,
    )
