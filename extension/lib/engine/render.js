// Rendering pipeline: squircle plates, adaptive contrast, shadow decay.
// Port of backend/icon_normalizer/core/renderer.py. The measure-correct loop
// always resamples from the original crop, never from an already-resampled
// candidate, so multi-size output stays faithful to the source.
// SPDX-License-Identifier: GPL-3.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {analyze} from './analyze.js';
import {pixelsOf, pyRound} from './util.js';

/** Squircle exponent (n=4) and the shadow strength behind glyph plates. */
export const SQUIRCLE_EXPONENT = 4;
export const SHADOW_ALPHA = 0.28;

/**
 * Build a pixbuf from an RGBA buffer.
 *
 * @param {Uint8Array} buf RGBA bytes
 * @param {number} width
 * @param {number} height
 * @returns {object} GdkPixbuf with alpha
 */
function pixbufFromRGBA(buf, width, height) {
    return GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
}

/**
 * Lanczos kernel with a = 3, the filter PIL uses for Image.LANCZOS.
 *
 * @param {number} x distance in source pixels
 * @returns {number} weight
 */
function lanczos(x) {
    if (x === 0) return 1;
    const ax = Math.abs(x);
    if (ax >= 3) return 0;
    const px = Math.PI * x;
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/**
 * Precompute one axis of Lanczos weights.
 *
 * @param {number} srcLen source length
 * @param {number} dstLen destination length
 * @returns {Array<Array<[number, number]>>} [index, weight] pairs per output
 */
function lanczosCoefficients(srcLen, dstLen) {
    const scale = dstLen / srcLen;
    const filterScale = Math.max(1, 1 / scale);
    const support = 3 * filterScale;
    const rows = [];
    for (let i = 0; i < dstLen; i++) {
        const center = (i + 0.5) / scale;
        const lo = Math.max(0, Math.floor(center - support));
        const hi = Math.min(srcLen - 1, Math.ceil(center + support));
        const pairs = [];
        let sum = 0;
        for (let j = lo; j <= hi; j++) {
            const weight = lanczos((j + 0.5 - center) / filterScale);
            if (weight === 0) continue;
            pairs.push([j, weight]);
            sum += weight;
        }
        if (sum === 0) pairs.push([Math.min(srcLen - 1, Math.floor(center)), 1]);
        else for (const pair of pairs) pair[1] /= sum;
        rows.push(pairs);
    }
    return rows;
}

/**
 * Separable Lanczos resize, matching PIL closely enough for parity.
 *
 * Colours are premultiplied before filtering and un-premultiplied afterwards,
 * so translucent pixels cannot bleed colour into opaque neighbours. PIL filters
 * each RGBA channel independently; for mostly-opaque icon artwork the two agree
 * well within the parity thresholds (tools/parity.py), and premultiplication is
 * strictly more correct at soft alpha edges.
 *
 * @param {object} pb source GdkPixbuf
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {object} new GdkPixbuf
 */
export function resizeLanczos(pb, outWidth, outHeight) {
    const {width, height, rowstride, data} = pixelsOf(pb);
    if (width === outWidth && height === outHeight) return pb;

    const xCoeffs = lanczosCoefficients(width, outWidth);
    const horizontal = new Float32Array(outWidth * height * 4);
    for (let y = 0; y < height; y++) {
        const row = y * rowstride;
        for (let x = 0; x < outWidth; x++) {
            const pairs = xCoeffs[x];
            let r = 0, g = 0, b = 0, a = 0;
            for (const [sx, weight] of pairs) {
                const i = row + sx * 4;
                const alpha = data[i + 3];
                // PIL premultiplies alpha before filtering, so colours in
                // translucent pixels cannot bleed into opaque neighbours.
                const factor = alpha / 255;
                r += data[i] * factor * weight;
                g += data[i + 1] * factor * weight;
                b += data[i + 2] * factor * weight;
                a += alpha * weight;
            }
            const o = (y * outWidth + x) * 4;
            horizontal[o] = r; horizontal[o + 1] = g;
            horizontal[o + 2] = b; horizontal[o + 3] = a;
        }
    }

    const yCoeffs = lanczosCoefficients(height, outHeight);
    const out = new Uint8Array(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
        const pairs = yCoeffs[y];
        for (let x = 0; x < outWidth; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (const [sy, weight] of pairs) {
                const i = (sy * outWidth + x) * 4;
                r += horizontal[i] * weight;
                g += horizontal[i + 1] * weight;
                b += horizontal[i + 2] * weight;
                a += horizontal[i + 3] * weight;
            }
            const o = (y * outWidth + x) * 4;
            if (a > 0) {
                const scale = 255 / a;
                out[o] = Math.min(255, Math.max(0, Math.round(r * scale)));
                out[o + 1] = Math.min(255, Math.max(0, Math.round(g * scale)));
                out[o + 2] = Math.min(255, Math.max(0, Math.round(b * scale)));
            }
            out[o + 3] = Math.min(255, Math.max(0, Math.round(a)));
        }
    }
    return pixbufFromRGBA(out, outWidth, outHeight);
}
/**
 * Anti-aliased squircle alpha mask.
 *
 * Supersampling gives smooth edges at small output sizes; exponent 4 is a
 * squircle, exponent 5 approaches a circle while keeping flat sides.
 *
 * @param {number} size output edge in pixels
 * @param {number} exponent superellipse exponent
 * @returns {Uint8Array} size*size alpha bytes
 */
export function superellipseAlpha(size, exponent = SQUIRCLE_EXPONENT) {
    const res = Math.max(size * 4, 256);
    const buf = new Uint8Array(res * res * 4);
    const half = res / 2;
    for (let y = 0; y < res; y++) {
        const ny = Math.abs((y + 0.5 - half) / half) ** exponent;
        for (let x = 0; x < res; x++) {
            const nx = Math.abs((x + 0.5 - half) / half) ** exponent;
            if (nx + ny > 1) continue;
            const i = (y * res + x) * 4;
            buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
        }
    }
    const hi = pixbufFromRGBA(buf, res, res);
    const lo = resizeLanczos(hi, size, size);
    const out = new Uint8Array(size * size);
    const px = pixelsOf(lo);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            out[y * size + x] = px.data[y * px.rowstride + x * 4 + 3];
    return out;
}

/**
 * Alpha-weighted Rec.709 luminance of a pixbuf.
 *
 * @param {object} pb GdkPixbuf
 * @returns {number} luminance in 0..1
 */
export function luminance(pb) {
    const {width, height, rowstride, channels, data} = pixelsOf(pb);
    let weighted = 0, total = 0;
    for (let y = 0; y < height; y++) {
        const row = y * rowstride;
        for (let x = 0; x < width; x++) {
            const i = row + x * 4;
            const a = (channels === 4 ? data[i + 3] : 255) / 255;
            weighted += ((data[i] / 255) * 0.2126 + (data[i + 1] / 255) * 0.7152
                + (data[i + 2] / 255) * 0.0722) * a;
            total += a;
        }
    }
    return total > 0 ? weighted / total : 0;
}

/**
 * Frosted squircle plate whose tone adapts to the glyph luminance.
 *
 * Light glyphs sit on a dark plate, dark glyphs on a light plate; the tint is
 * an alpha-weighted Rec.709 decision at the 0.55 threshold.
 *
 * @param {number} size plate edge in pixels
 * @param {object} glyph GdkPixbuf of the source artwork
 * @returns {{pixbuf: object, kind: string}} plate and "dark" | "light"
 */
export function makePlate(size, glyph) {
    const dark = luminance(glyph) > 0.55;
    const top = dark ? [58, 58, 62] : [248, 248, 250];
    const bottom = dark ? [32, 32, 36] : [228, 228, 232];
    const mask = superellipseAlpha(size);
    const buf = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        const t = y / Math.max(size - 1, 1);
        const r = pyRound(top[0] + (bottom[0] - top[0]) * t);
        const g = pyRound(top[1] + (bottom[1] - top[1]) * t);
        const b = pyRound(top[2] + (bottom[2] - top[2]) * t);
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
            buf[i + 3] = mask[y * size + x];
        }
    }
    return {pixbuf: pixbufFromRGBA(buf, size, size), kind: dark ? "dark" : "light"};
}

/**
 * Separable Gaussian blur of an alpha buffer.
 *
 * PIL approximates GaussianBlur with three box blurs; a true Gaussian is close
 * enough for a soft drop shadow.
 *
 * @param {Float32Array} src alpha 0..255
 * @param {number} size edge length
 * @param {number} sigma standard deviation
 * @returns {Float32Array} blurred alpha
 */
export function blurAlpha(src, size, sigma) {
    if (sigma <= 0) return src;
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-(i * i) / (2 * sigma * sigma));
        kernel[i + radius] = v;
        sum += v;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const tmp = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                // Edge replication, matching PIL's GaussianBlur border mode:
                // zero padding would darken shadow alpha near the canvas edge.
                const xx = Math.min(size - 1, Math.max(0, x + k));
                acc += src[y * size + xx] * kernel[k + radius];
            }
            tmp[y * size + x] = acc;
        }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = Math.min(size - 1, Math.max(0, y + k));
                acc += tmp[yy * size + x] * kernel[k + radius];
            }
            out[y * size + x] = acc;
        }
    return out;
}

/**
 * Alpha-composite one pixbuf over another at destination coordinates (x, y).
 *
 * @param {object} src source GdkPixbuf
 * @param {object} dst destination GdkPixbuf
 * @param {number} x target x offset
 * @param {number} y target y offset
 */
export function pastePixbuf(src, dst, x, y) {
    const sw = src.get_width(), sh = src.get_height();
    const dw = dst.get_width(), dh = dst.get_height();
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(dw, x + sw);
    const y1 = Math.min(dh, y + sh);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    src.composite(dst, x0, y0, w, h, x, y, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
}

/**
 * Multiply a pixbuf alpha channel by a mask, keeping its colours.
 *
 * @param {object} pb GdkPixbuf
 * @param {Uint8Array} mask alpha bytes, one per pixel
 * @returns {object} new GdkPixbuf
 */
export function multiplyAlpha(pb, mask) {
    const {width, height, rowstride, data} = pixelsOf(pb);
    const buf = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = y * rowstride;
        for (let x = 0; x < width; x++) {
            const src = row + x * 4;
            const dst = (y * width + x) * 4;
            buf[dst] = data[src];
            buf[dst + 1] = data[src + 1];
            buf[dst + 2] = data[src + 2];
            buf[dst + 3] = Math.round(data[src + 3] * mask[y * width + x] / 255);
        }
    }
    return pixbufFromRGBA(buf, width, height);
}

/**
 * Squircle mask scaled to a non-square box, for the plate-rounded class.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} width*height alpha bytes
 */
export function squircleMaskFor(width, height) {
    const edge = Math.max(width, height);
    const square = superellipseAlpha(edge);
    if (width === edge && height === edge) return square;
    const buf = new Uint8Array(edge * edge * 4);
    for (let i = 0; i < square.length; i++) {
        buf[i * 4] = 255; buf[i * 4 + 1] = 255; buf[i * 4 + 2] = 255;
        buf[i * 4 + 3] = square[i];
    }
    const scaled = resizeLanczos(pixbufFromRGBA(buf, edge, edge), width, height);
    const px = pixelsOf(scaled);
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            out[y * width + x] = px.data[y * px.rowstride + x * 4 + 3];
    return out;
}

/**
 * Soft drop shadow behind a glyph plate.
 *
 * @param {number} size canvas edge
 * @param {number} platePx plate edge
 * @param {number} origin plate offset
 * @param {number} dy shadow vertical offset
 * @returns {object} GdkPixbuf with shadow alpha
 */
function buildShadow(size, platePx, origin, dy) {
    const mask = superellipseAlpha(platePx);
    const canvas = new Float32Array(size * size);
    for (let y = 0; y < platePx; y++) {
        const ty = y + origin + dy;
        if (ty < 0 || ty >= size) continue;
        for (let x = 0; x < platePx; x++) {
            const tx = x + origin;
            if (tx < 0 || tx >= size) continue;
            canvas[ty * size + tx] = mask[y * platePx + x];
        }
    }
    const sigma = Math.max(0.5, size * 0.012);
    const blurred = blurAlpha(canvas, size, sigma);
    const buf = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++)
        buf[i * 4 + 3] = Math.min(255, pyRound(blurred[i] * SHADOW_ALPHA));
    return pixbufFromRGBA(buf, size, size);
}

/**
 * Render one normalized candidate.
 *
 * The core is scaled to ``target`` (or ``target*inner`` for glyph plates); the
 * full shadow extent is clamped to stay inside the canvas; glyphs get a soft
 * drop shadow behind an adaptive squircle plate.
 *
 * @param {object} source GdkPixbuf with alpha
 * @param {object} metrics result of analyze()
 * @param {string} cls classification name
 * @param {{size?: number, target?: number, inner?: number}} options
 * @returns {{pixbuf: object, info: object}}
 */
export function normalize(source, metrics, cls, options = {}) {
    const {size = 256, target = 0.88, inner = 0.72} = options;
    const core = metrics.core_bbox;
    const full = metrics.full_bbox;
    const extent = Math.max(core[2] - core[0], core[3] - core[1]);
    const targetPx = pyRound(size * target);
    let scale = (cls === "glyph" ? pyRound(targetPx * inner) : targetPx) / extent;
    // Keep the complete meaningful shadow within the canvas while centring the core.
    const halfExtent = Math.max(
        metrics.cx - full[0], full[2] - metrics.cx,
        metrics.cy - full[1], full[3] - metrics.cy);
    const safe = (size / 2 - 0.5) / halfExtent;
    const clamped = scale > safe;
    scale = Math.min(scale, safe);

    let crop = source.new_subpixbuf(full[0], full[1], full[2] - full[0], full[3] - full[1]);
    let plate = null;
    let shadow = null;
    let origin = 0;
    if (cls === "glyph") {
        plate = makePlate(targetPx, source);
        origin = Math.floor((size - targetPx) / 2);
        shadow = buildShadow(size, targetPx, origin, Math.max(1, pyRound(size * 0.01)));
    }
    if (cls === "plate-rounded") {
        // Keep the artwork but replace its silhouette with a squircle.
        crop = multiplyAlpha(crop, squircleMaskFor(crop.get_width(), crop.get_height()));
    }

    const desired = cls === "glyph" ? pyRound(targetPx * inner) : targetPx;
    let best = null;
    for (let iteration = 0; iteration < 4; iteration++) {
        const width = Math.max(1, pyRound(crop.get_width() * scale));
        const height = Math.max(1, pyRound(crop.get_height() * scale));
        const scaled = (crop.get_width() === width && crop.get_height() === height)
            ? crop : resizeLanczos(crop, width, height);
        const offsetX = pyRound(size / 2 - (metrics.cx - full[0]) * scale);
        const offsetY = pyRound(size / 2 - (metrics.cy - full[1]) * scale);

        // Measure the glyph-only layer: the plate dominates source_ratio and
        // would send the correction loop the wrong way.
        const layer = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, size, size);
        layer.fill(0);
        pastePixbuf(scaled, layer, offsetX, offsetY);

        let measured = 0;
        try {
            measured = pyRound(analyze(layer).source_ratio * size);
        } catch {
            measured = 0;
        }
        const error = Math.abs(measured - desired);
        if (!best || error < best.error)
            best = {error, scaled, offsetX, offsetY, scale, measured};
        if (error === 0 || measured === 0) break;
        const proposed = Math.min(scale * desired / measured, safe);
        if (Math.abs(proposed - scale) < 1e-12) break;
        scale = proposed;
    }

    const out = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, size, size);
    out.fill(0);
    if (shadow) pastePixbuf(shadow, out, 0, 0);
    if (plate) pastePixbuf(plate.pixbuf, out, origin, origin);
    pastePixbuf(best.scaled, out, best.offsetX, best.offsetY);

    return {
        pixbuf: out,
        info: {
            plate_color: plate ? plate.kind : null,
            shadow_clamped: clamped,
            effective_scale_native: best.scale,
            crop_bbox: full.slice(),
            content_core_pixels: best.measured,
            desired_content_core_pixels: desired,
            pixel_target_error: best.measured - desired,
        },
    };
}
export {pixbufFromRGBA};
