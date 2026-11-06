"""A square plate can be rendered with a squircle silhouette on request."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from PIL import Image, ImageDraw

from icon_normalizer.core.analyzer import (
    CLASSES,
    IconMetrics,
    analyze,
    suggest_class,
)
from icon_normalizer.core.classification import RULE_STATE_ACTIVE, describe_rule
from icon_normalizer.core.renderer import normalize


def square_plate(size: int = 256, radius: int = 0) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((8, 8, size - 9, size - 9), radius=radius,
                           fill=(245, 246, 248, 255))
    draw.ellipse((size // 3, size // 3, size * 2 // 3, size * 2 // 3),
                 fill=(40, 44, 52, 255))
    return image


def corner_alpha(image: Image.Image, inset: float = 0.10) -> float:
    """Opacity at the four corners of the plate area (canvas inset by 10%)."""
    alpha = image.getchannel("A")
    w, h = image.size
    d = round(min(w, h) * inset)
    pts = [(d, d), (w - 1 - d, d), (d, h - 1 - d), (w - 1 - d, h - 1 - d)]
    return sum(alpha.getpixel(p) for p in pts) / (4 * 255)


class SuggestClass(unittest.TestCase):
    def test_sharp_plate_is_suggested_for_rounding(self):
        metrics = analyze(square_plate(radius=0))
        self.assertGreaterEqual(metrics.corner_alpha, 0.5)
        self.assertEqual(suggest_class(metrics), "plate-rounded")

    def test_rounded_plate_needs_no_suggestion(self):
        metrics = analyze(square_plate(radius=48))
        self.assertLess(metrics.corner_alpha, 0.5)
        self.assertIsNone(suggest_class(metrics))


class RenderPlateRounded(unittest.TestCase):
    def setUp(self):
        self.image = square_plate(radius=0)
        self.metrics = analyze(self.image)

    def test_plate_rect_keeps_square_corners(self):
        out, _info = normalize(self.image, self.metrics, "plate-rect", 256)
        self.assertGreater(corner_alpha(out), 0.9)

    def test_plate_rounded_masks_the_corners(self):
        out, _info = normalize(self.image, self.metrics, "plate-rounded", 256)
        self.assertLess(corner_alpha(out), 0.05)
        self.assertEqual(out.getpixel((128, 128))[3], 255)
        self.assertGreater(out.getpixel((128, 40))[3], 200)

    def test_plate_rounded_is_a_selectable_class(self):
        self.assertIn("plate-rounded", CLASSES)
        decision, state, _detail = describe_rule({"classification": "plate-rounded"}, "a" * 64)
        self.assertEqual((state, decision["class"]), (RULE_STATE_ACTIVE, "plate-rounded"))


if __name__ == "__main__":
    unittest.main()
