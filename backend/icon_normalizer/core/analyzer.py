"""Alpha-channel geometry analysis, classification and dead-band planning.

Pure functions over PIL images / numpy arrays. Thresholds and the dead-band
formula are frozen: CORE_ALPHA=200 marks the meaningful core, FULL_ALPHA=8 the
outer shadow halo; the ±2 percentage-point dead band preserves in-tolerance
vendor artwork untouched.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

CORE_ALPHA = 200
FULL_ALPHA = 8

#: Exponent of the fitted ellipse silhouette test and IoU gates are kept here so
#: the classifier stays a single readable table.
CIRCLE_ASPECT_RANGE = (0.95, 1.05)
CIRCLE_IOU_MIN = 0.92
RECT_FILL_MIN = 0.86
RECT_RING_MIN = 0.75

CLASSES = ("plate-rect", "plate-circle", "artwork", "glyph")


@dataclass(frozen=True)
class Classification:
    cls: str
    reason: str
    confidence: str  # 'high' | 'medium' | 'review' | 'reviewed' | 'user' | 'automatic'


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.where(mask)
    if not len(xs):
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1))


class AnalysisError(ValueError):
    """The artwork has no opaque core and cannot be measured."""


@dataclass(frozen=True)
class IconMetrics:
    """Measured geometry of one source image.

    ``as_dict``/``from_dict`` key sets are frozen: they are persisted inside
    ``manifest.json``'s analysis cache.
    """

    core_bbox: tuple[int, int, int, int]
    full_bbox: tuple[int, int, int, int]
    source_ratio: float
    strict_ratio: float | None
    width_ratio: float
    height_ratio: float
    fill: float
    ring: float
    ellipse_iou: float
    aspect: float
    cx: float
    cy: float
    core_alpha: int = CORE_ALPHA
    full_alpha: int = FULL_ALPHA

    def as_dict(self) -> dict[str, Any]:
        return {
            "core_bbox": list(self.core_bbox),
            "full_bbox": list(self.full_bbox),
            "source_ratio": self.source_ratio,
            "strict_ratio": self.strict_ratio,
            "width_ratio": self.width_ratio,
            "height_ratio": self.height_ratio,
            "fill": self.fill,
            "ring": self.ring,
            "ellipse_iou": self.ellipse_iou,
            "aspect": self.aspect,
            "cx": self.cx,
            "cy": self.cy,
            "core_alpha": self.core_alpha,
            "full_alpha": self.full_alpha,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IconMetrics":
        return cls(
            core_bbox=tuple(data["core_bbox"]),
            full_bbox=tuple(data["full_bbox"]),
            source_ratio=float(data["source_ratio"]),
            strict_ratio=None if data.get("strict_ratio") is None else float(data["strict_ratio"]),
            width_ratio=float(data["width_ratio"]),
            height_ratio=float(data["height_ratio"]),
            fill=float(data["fill"]),
            ring=float(data["ring"]),
            ellipse_iou=float(data["ellipse_iou"]),
            aspect=float(data["aspect"]),
            cx=float(data["cx"]),
            cy=float(data["cy"]),
            core_alpha=int(data.get("core_alpha", CORE_ALPHA)),
            full_alpha=int(data.get("full_alpha", FULL_ALPHA)),
        )


def analyze(img: Image.Image) -> IconMetrics:
    alpha = np.asarray(img)[:, :, 3]
    core = bbox_of(alpha > CORE_ALPHA)
    full = bbox_of(alpha > FULL_ALPHA)
    if core is None or full is None:
        raise AnalysisError("Icon has no opaque core")
    x0, y0, x1, y1 = core
    mask = alpha[y0:y1, x0:x1] > CORE_ALPHA
    h, w = mask.shape
    yy, xx = np.mgrid[:h, :w]
    ellipse = ((xx + 0.5 - w / 2) / (w / 2)) ** 2 + ((yy + 0.5 - h / 2) / (h / 2)) ** 2 <= 1
    ellipse_iou = float((mask & ellipse).sum() / (mask | ellipse).sum())
    ix = min(w - 1, max(0, round(w * 0.08)))
    iy = min(h - 1, max(0, round(h * 0.08)))
    x_end = max(ix + 1, w - ix)
    y_end = max(iy + 1, h - iy)
    ring = np.concatenate(
        [mask[iy, ix:x_end], mask[h - 1 - iy, ix:x_end], mask[iy:y_end, ix], mask[iy:y_end, w - 1 - ix]]
    )
    strict = bbox_of(alpha > 250)
    canvas = max(img.size)
    return IconMetrics(
        core_bbox=core,
        full_bbox=full,
        source_ratio=max(w, h) / canvas,
        strict_ratio=(
            max(strict[2] - strict[0], strict[3] - strict[1]) / canvas if strict else None
        ),
        width_ratio=w / canvas,
        height_ratio=h / canvas,
        fill=float(mask.mean()),
        ring=float(ring.mean()),
        ellipse_iou=ellipse_iou,
        aspect=w / h,
        cx=(x0 + x1) / 2,
        cy=(y0 + y1) / 2,
    )


def classify(metrics: IconMetrics) -> Classification:
    # Shape descriptors suggest a class; they do not prove a semantic plate.
    if (
        CIRCLE_ASPECT_RANGE[0] <= metrics.aspect <= CIRCLE_ASPECT_RANGE[1]
        and metrics.ellipse_iou >= CIRCLE_IOU_MIN
    ):
        return Classification("plate-circle", "ellipse_silhouette", "high")
    if metrics.fill >= RECT_FILL_MIN and metrics.ring >= RECT_RING_MIN:
        return Classification("plate-rect", "filled_silhouette", "medium")
    return Classification("artwork", "ambiguous_preserve_artwork", "review")


@dataclass(frozen=True)
class Plan:
    action: str  # keep | enlarge | shrink | add_plate
    reason: str
    target_ratio: float
    inner_target_ratio: float | None
    scale: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "reason": self.reason,
            "target_ratio": self.target_ratio,
            "inner_target_ratio": self.inner_target_ratio,
            "scale": self.scale,
        }


def plan(
    metrics: IconMetrics,
    cls: str,
    target: float = 0.88,
    deadband: float = 0.02,
    inner: float = 0.72,
) -> Plan:
    """Decide the action for one icon under the target/dead-band policy."""
    src = metrics.source_ratio
    if cls == "glyph":
        return Plan(
            action="add_plate",
            reason="reviewed_glyph",
            target_ratio=target,
            inner_target_ratio=target * inner,
            scale=target * inner / src,
        )
    if target - deadband - 1e-9 <= src <= target + deadband + 1e-9:
        return Plan(
            action="keep",
            reason="within_deadband",
            target_ratio=target,
            inner_target_ratio=None,
            scale=1.0,
        )
    action = "enlarge" if src < target else "shrink"
    return Plan(
        action=action,
        reason="outside_deadband",
        target_ratio=target,
        inner_target_ratio=None,
        scale=target / src,
    )
