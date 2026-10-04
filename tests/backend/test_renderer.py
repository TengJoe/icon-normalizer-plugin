"""Renderer tests: squircle masks, contrast plates, target-ratio convergence."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from icon_normalizer.core.analyzer import analyze  # noqa: E402
from icon_normalizer.core.renderer import (  # noqa: E402
    RenderInfo,
    fit_original,
    make_plate,
    normalize,
    superellipse_mask,
)


def rounded_rect(extent: int, color: str = "red") -> Image.Image:
    image = Image.new("RGBA", (256, 256))
    off = (256 - extent) // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (off, off, off + extent - 1, off + extent - 1), radius=20, fill=color
    )
    return image


class TestSuperellipse(unittest.TestCase):
    def test_mask_is_opaque_center_transparent_corners(self) -> None:
        mask = np.asarray(superellipse_mask(128))
        self.assertEqual(int(mask[64, 64]), 255)
        self.assertEqual(int(mask[0, 0]), 0)
        # flat sides present (squircle, not circle): mid-edge is opaque
        self.assertEqual(int(mask[64, 2]), 255)

    def test_mask_edges_anti_aliased(self) -> None:
        mask = np.asarray(superellipse_mask(64))
        partial = mask[(mask > 0) & (mask < 255)]
        self.assertTrue(len(partial) > 10, "mask boundary should be anti-aliased")


class TestMakePlate(unittest.TestCase):
    def test_light_glyph_gets_dark_plate(self) -> None:
        glyph = Image.new("RGBA", (64, 64), (255, 255, 255, 255))
        plate, kind = make_plate(128, glyph)
        self.assertEqual(kind, "dark")
        center = plate.getpixel((64, 64))
        self.assertLess(sum(center[:3]) / 3, 128)

    def test_dark_glyph_gets_light_plate(self) -> None:
        glyph = Image.new("RGBA", (64, 64), (10, 10, 30, 255))
        plate, kind = make_plate(128, glyph)
        self.assertEqual(kind, "light")
        center = plate.getpixel((64, 64))
        self.assertGreater(sum(center[:3]) / 3, 128)

    def test_plate_alpha_is_squircle(self) -> None:
        glyph = Image.new("RGBA", (64, 64), (255, 255, 255, 255))
        plate, _kind = make_plate(128, glyph)
        alpha = np.asarray(plate)[:, :, 3]
        self.assertEqual(int(alpha[64, 64]), 255)
        self.assertEqual(int(alpha[0, 0]), 0)


class TestNormalize(unittest.TestCase):
    def test_target_ratio_converges(self) -> None:
        for extent in (198, 224, 252):
            src = rounded_rect(extent)
            st = analyze(src)
            out, info = normalize(src, st, "plate-rect", 256)
            measured = analyze(out).source_ratio
            self.assertAlmostEqual(measured, 0.88, delta=0.01, msg=f"extent={extent}")
            self.assertEqual(info.desired_content_core_pixels, round(256 * 0.88))
            self.assertLessEqual(abs(info.pixel_target_error), 1)

    def test_glyph_render_includes_plate_and_shadow(self) -> None:
        src = Image.new("RGBA", (256, 256))
        ImageDraw.Draw(src).polygon([(100, 60), (170, 80), (150, 170), (90, 150)],
                                    fill=(240, 240, 240, 255))
        st = analyze(src)
        out, info = normalize(src, st, "glyph", 256)
        self.assertEqual(info.plate_color, "dark")
        corners_opaque = np.asarray(out)[0, 0, 3]
        self.assertEqual(int(corners_opaque), 0)  # squircle corners stay transparent
        plate_center = int(np.asarray(out)[128, 128, 3])
        self.assertEqual(plate_center, 255)
        # inner glyph kept near target*inner
        measured = analyze(out).source_ratio
        self.assertAlmostEqual(measured, 0.88, delta=0.015)

    def test_shadow_clamped_for_wide_halo(self) -> None:
        # artwork with a huge faint halo: safe scale clamps below target
        src = Image.new("RGBA", (256, 256))
        ImageDraw.Draw(src).rounded_rectangle((120, 120, 136, 136), fill="red")
        ImageDraw.Draw(src).rectangle((2, 2, 253, 253), outline=(0, 0, 0, 20), width=2)
        st = analyze(src)
        out, info = normalize(src, st, "artwork", 256)
        self.assertTrue(info.shadow_clamped)
        half_extent = max(
            st.cx - st.full_bbox[0], st.full_bbox[2] - st.cx,
            st.cy - st.full_bbox[1], st.full_bbox[3] - st.cy,
        )
        safe = (256 / 2 - 0.5) / half_extent
        self.assertAlmostEqual(info.effective_scale_native, safe, places=9)
        self.assertLess(info.effective_scale_native, 0.88 / (st.core_bbox[2] - st.core_bbox[0]) * 256)

    def test_render_info_round_trip(self) -> None:
        src = rounded_rect(198)
        st = analyze(src)
        _out, info = normalize(src, st, "plate-rect", 256)
        restored = RenderInfo.from_dict(info.as_dict())
        self.assertEqual(restored, info)

    def test_multi_size_outputs_descend(self) -> None:
        src = rounded_rect(198)
        st = analyze(src)
        pixels = {}
        for size in (16, 48, 128, 256):
            out, info = normalize(src, st, "plate-rect", size)
            measured = analyze(out).source_ratio
            pixels[size] = info.content_core_pixels
            self.assertAlmostEqual(measured, 0.88, delta=0.02)
        self.assertLess(pixels[16], pixels[48])
        self.assertLess(pixels[48], pixels[128])
        self.assertLess(pixels[128], pixels[256])

    def test_fit_original_for_keep(self) -> None:
        src = make_icon_png(224)
        out = fit_original(src, 256)
        self.assertEqual(out.size, (256, 256))
        self.assertAlmostEqual(analyze(out).source_ratio, 224 / 256, delta=0.005)


def make_icon_png(extent: int) -> Image.Image:
    image = Image.new("RGBA", (256, 256))
    off = (256 - extent) // 2
    ImageDraw.Draw(image).rounded_rectangle(
        (off, off, off + extent - 1, off + extent - 1), radius=20, fill="red"
    )
    return image


if __name__ == "__main__":
    unittest.main()
