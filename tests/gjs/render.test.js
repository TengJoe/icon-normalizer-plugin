// Unit tests for the GJS renderer. Run: gjs -m tests/gjs/render.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {analyze} from '../../extension/lib/engine/analyze.js';
import {
    makePlate, normalize, resizeLanczos, superellipseAlpha, luminance,
} from '../../extension/lib/engine/render.js';
import {test, assertEqual, assertClose, assertTrue, pixbufFromAlpha, report} from './harness.js';

function pixbufRGBA(width, height, fn) {
    const buf = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = fn(x, y);
            const i = (y * width + x) * 4;
            buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
}

function pixelAt(pb, x, y) {
    const rs = pb.get_rowstride();
    const data = pb.get_pixels();
    const i = y * rs + x * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

test('squircle mask is opaque at the centre and clear at the corners', () => {
    const size = 64;
    const mask = superellipseAlpha(size);
    assertEqual(mask[32 * size + 32], 255, 'centre');
    assertEqual(mask[0], 0, 'top-left corner');
    assertEqual(mask[size - 1], 0, 'top-right corner');
    assertEqual(mask[(size - 1) * size], 0, 'bottom-left corner');
});

test('squircle mask is symmetric on both axes', () => {
    const size = 32;
    const mask = superellipseAlpha(size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const value = mask[y * size + x];
            assertEqual(mask[y * size + (size - 1 - x)], value, 'horizontal mirror');
            assertEqual(mask[(size - 1 - y) * size + x], value, 'vertical mirror');
        }
    }
});

test('resize keeps colour at translucent edges (premultiplied alpha)', () => {
    // A red square on a transparent canvas. Filtering colour and alpha
    // independently would darken the edge toward black; PIL premultiplies,
    // so an edge pixel must stay red and only lose opacity.
    const source = pixbufRGBA(64, 64, (x, y) =>
        (x >= 16 && x < 48 && y >= 16 && y < 48) ? [255, 0, 0, 255] : [0, 0, 0, 0]);
    const scaled = resizeLanczos(source, 16, 16);
    // Scan the row through the square for the first translucent pixel.
    let edge = null;
    for (let x = 0; x < 16; x++) {
        const pixel = pixelAt(scaled, x, 8);
        if (pixel[3] > 0 && pixel[3] < 255) { edge = pixel; break; }
    }
    assertTrue(edge !== null, 'found a translucent edge pixel');
    assertTrue(edge[0] > 200, 'edge keeps its red channel, got ' + edge[0]);
    assertTrue(edge[1] < 40 && edge[2] < 40, 'edge stays red rather than washing out');
});

test('a light glyph gets a dark plate and vice versa', () => {
    const light = pixbufRGBA(32, 32, () => [250, 250, 250, 255]);
    const dark = pixbufRGBA(32, 32, () => [20, 20, 20, 255]);
    assertEqual(makePlate(16, light).kind, 'dark', 'light glyph');
    assertEqual(makePlate(16, dark).kind, 'light', 'dark glyph');
    assertClose(luminance(light), 250 / 255, 1e-6, 'luminance');
});

test('plate gradient runs from the top colour to the bottom colour', () => {
    const dark = pixbufRGBA(32, 32, () => [20, 20, 20, 255]);
    const plate = makePlate(64, dark).pixbuf;
    const top = pixelAt(plate, 32, 0);
    const bottom = pixelAt(plate, 32, 63);
    assertEqual(top[0], 248, 'top red');
    assertEqual(bottom[0], 228, 'bottom red');
});

test('normalize hits the requested coverage for a square plate', () => {
    const source = pixbufFromAlpha(128, 128, () => 255);
    const metrics = analyze(source);
    for (const size of [32, 64, 128]) {
        const {pixbuf, info} = normalize(source, metrics, 'plate-rect',
            {size, target: 0.83, inner: 0.7});
        assertEqual(info.desired_content_core_pixels,
            Math.round(size * 0.83), 'desired for ' + size);
        assertEqual(info.content_core_pixels, info.desired_content_core_pixels,
            'measured for ' + size);
        assertEqual(pixbuf.get_width(), size, 'output width');
    }
});

test('normalize clamps artwork that would overflow its shadow', () => {
    // Opaque core with a wide translucent halo: scaling the core to target
    // would push the halo past the canvas, so the scale must be clamped.
    const source = pixbufRGBA(128, 128, (x, y) => {
        const dx = Math.abs(x - 64), dy = Math.abs(y - 64);
        if (dx < 40 && dy < 40) return [40, 40, 40, 255];
        if (dx < 62 && dy < 62) return [40, 40, 40, 20];
        return [0, 0, 0, 0];
    });
    const metrics = analyze(source);
    const {info} = normalize(source, metrics, 'artwork', {size: 64, target: 0.83});
    assertTrue(info.shadow_clamped, 'clamped');
});

report();
