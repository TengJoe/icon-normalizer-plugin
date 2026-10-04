"""Analyzer geometry classification and dead-band planning tests."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from PIL import Image, ImageDraw  # noqa: E402

from icon_normalizer.core.analyzer import (  # noqa: E402
    IconMetrics,
    analyze,
    classify,
    plan,
)


def rounded_rect(extent: int, radius: int = 20, color: str = "red") -> Image.Image:
    image = Image.new("RGBA", (256, 256))
    off = (256 - extent) // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (off, off, off + extent - 1, off + extent - 1), radius=radius, fill=color
    )
    return image


def circle(diameter: int, color: str = "blue") -> Image.Image:
    image = Image.new("RGBA", (256, 256))
    off = (256 - diameter) // 2
    ImageDraw.Draw(image).ellipse((off, off, off + diameter - 1, off + diameter - 1), fill=color)
    return image


def bare_glyph(color: str = "yellow") -> Image.Image:
    """A small irregular logo shape on a transparent canvas."""
    image = Image.new("RGBA", (256, 256))
    draw = ImageDraw.Draw(image)
    draw.polygon([(100, 60), (170, 80), (150, 170), (90, 150)], fill=color)
    return image


class TestClassify(unittest.TestCase):
    def test_rounded_rect_is_plate_rect(self) -> None:
        st = analyze(rounded_rect(200))
        cls = classify(st)
        self.assertEqual(cls.cls, "plate-rect")
        self.assertEqual(cls.confidence, "medium")

    def test_circle_is_plate_circle(self) -> None:
        st = analyze(circle(200))
        cls = classify(st)
        self.assertEqual(cls.cls, "plate-circle")
        self.assertEqual(cls.confidence, "high")

    def test_small_shape_is_artwork_review(self) -> None:
        st = analyze(bare_glyph())
        cls = classify(st)
        self.assertEqual(cls.cls, "artwork")
        self.assertEqual(cls.confidence, "review")

    def test_metrics_round_trip(self) -> None:
        st = analyze(rounded_rect(200))
        restored = IconMetrics.from_dict(st.as_dict())
        self.assertEqual(restored, st)


class TestPlanDeadband(unittest.TestCase):
    def test_within_deadband_keeps(self) -> None:
        # 0.875 is inside 0.86..0.90
        st = analyze(rounded_rect(224))
        self.assertAlmostEqual(st.source_ratio, 0.875, places=2)
        decision = plan(st, "plate-rect")
        self.assertEqual(decision.action, "keep")
        self.assertEqual(decision.reason, "within_deadband")
        self.assertEqual(decision.scale, 1.0)

    def test_small_icon_enlarges(self) -> None:
        st = analyze(rounded_rect(198))
        decision = plan(st, "plate-rect")
        self.assertEqual(decision.action, "enlarge")
        self.assertAlmostEqual(decision.scale, 0.88 / st.source_ratio)

    def test_large_icon_shrinks(self) -> None:
        st = analyze(rounded_rect(252))
        decision = plan(st, "plate-rect")
        self.assertEqual(decision.action, "shrink")

    def test_glyph_adds_plate(self) -> None:
        st = analyze(bare_glyph())
        decision = plan(st, "glyph", target=0.88, deadband=0.02, inner=0.72)
        self.assertEqual(decision.action, "add_plate")
        self.assertAlmostEqual(decision.inner_target_ratio, 0.88 * 0.72, places=6)
        self.assertAlmostEqual(decision.scale, 0.88 * 0.72 / st.source_ratio)

    def test_deadband_edges(self) -> None:
        # boundary values via synthetic metrics
        base = analyze(rounded_rect(200))
        lower = IconMetrics(**{**base.as_dict(), "source_ratio": 0.86})
        self.assertEqual(plan(lower, "plate-rect").action, "keep")
        outside = IconMetrics(**{**base.as_dict(), "source_ratio": 0.859})
        self.assertEqual(plan(outside, "plate-rect").action, "enlarge")
        upper = IconMetrics(**{**base.as_dict(), "source_ratio": 0.90})
        self.assertEqual(plan(upper, "plate-rect").action, "keep")
        beyond = IconMetrics(**{**base.as_dict(), "source_ratio": 0.901})
        self.assertEqual(plan(beyond, "plate-rect").action, "shrink")


if __name__ == "__main__":
    unittest.main()
