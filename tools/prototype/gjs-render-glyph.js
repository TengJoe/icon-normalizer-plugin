// GJS glyph-path prototype: plate + shadow + squircle mask.
// usage: gjs -m render-glyph.js <src.png> <outdir> [target] [inner]
import GdkPixbuf from 'gi://GdkPixbuf';
import Gdk from 'gi://Gdk?version=3.0';
import cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import System from 'system';

const [src, outdir, targetS = '0.83', innerS = '0.7'] = ARGV;
const target = Number(targetS), inner = Number(innerS);
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];
const CORE_ALPHA = 200, FULL_ALPHA = 8;
const SQUIRCLE_EXPONENT = 4, SHADOW_ALPHA = 0.28;

function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
}

function pixelsOf(pb) {
    return {w: pb.get_width(), h: pb.get_height(), rs: pb.get_rowstride(),
            n: pb.get_n_channels(), data: pb.get_pixels()};
}

function analyze(pb) {
    const {w, h, rs, n, data} = pixelsOf(pb);
    let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1, fx0 = w, fy0 = h, fx1 = -1, fy1 = -1;
    for (let y = 0; y < h; y++) {
        const row = y * rs;
        for (let x = 0; x < w; x++) {
            const a = n === 4 ? data[row + x * 4 + 3] : 255;
            if (a > CORE_ALPHA) {
                if (x < cx0) cx0 = x; if (x > cx1) cx1 = x;
                if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
            }
            if (a > FULL_ALPHA) {
                if (x < fx0) fx0 = x; if (x > fx1) fx1 = x;
                if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
            }
        }
    }
    if (cx1 < 0 || fx1 < 0) return null;
    const core = {x0: cx0, y0: cy0, x1: cx1 + 1, y1: cy1 + 1};
    const full = {x0: fx0, y0: fy0, x1: fx1 + 1, y1: fy1 + 1};
    const cw = core.x1 - core.x0, ch = core.y1 - core.y0;
    return {core, full, sourceRatio: Math.max(cw, ch) / Math.max(w, h),
            cx: (core.x0 + core.x1) / 2, cy: (core.y0 + core.y1) / 2};
}

// Supersampled squircle alpha, mirroring renderer.superellipse_mask().
function superellipseAlpha(size, exponent = SQUIRCLE_EXPONENT) {
    const res = Math.max(size * 4, 256);
    const buf = new Uint8Array(res * res * 4);
    const half = res / 2;
    for (let y = 0; y < res; y++) {
        const ny = Math.abs((y + 0.5 - half) / half) ** exponent;
        for (let x = 0; x < res; x++) {
            const nx = Math.abs((x + 0.5 - half) / half) ** exponent;
            const i = (y * res + x) * 4;
            if (nx + ny <= 1) { buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255; }
        }
    }
    const bytes = GLib.Bytes.new(buf);
    const hi = GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, true, 8, res, res, res * 4);
    const lo = hi.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
    const out = new Uint8Array(size * size);
    const p = pixelsOf(lo);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
            out[y * size + x] = p.data[y * p.rs + x * 4 + 3];
    return out;
}

// Separable Gaussian on an alpha buffer. PIL approximates its GaussianBlur with
// three box blurs; a true Gaussian is close enough for a soft drop shadow.
function blurAlpha(buf, size, sigma) {
    if (sigma <= 0) return buf;
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-(i * i) / (2 * sigma * sigma));
        kernel[i + radius] = v; sum += v;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const tmp = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = x + k;
                if (xx >= 0 && xx < size) acc += buf[y * size + xx] * kernel[k + radius];
            }
            tmp[y * size + x] = acc;
        }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = y + k;
                if (yy >= 0 && yy < size) acc += tmp[yy * size + x] * kernel[k + radius];
            }
            out[y * size + x] = acc;
        }
    return out;
}

// Alpha-weighted Rec.709 luminance, mirroring renderer.make_plate().
function luminance(pb) {
    const {w, h, rs, n, data} = pixelsOf(pb);
    let acc = 0, wsum = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * rs + x * 4;
            const a = n === 4 ? data[i + 3] : 255;
            const wa = a / 255;
            acc += (data[i] / 255 * 0.2126 + data[i + 1] / 255 * 0.7152 + data[i + 2] / 255 * 0.0722) * wa;
            wsum += wa;
        }
    return wsum > 0 ? acc / wsum : 0;
}

function makePlate(size, glyphPb) {
    const lum = luminance(glyphPb);
    const dark = lum > 0.55;                       // light glyph -> dark plate
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
    return {pb: GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
                GdkPixbuf.Colorspace.RGB, true, 8, size, size, size * 4),
            kind: dark ? 'dark' : 'light'};
}

function surfaceFromPixbuf(pb, size) {
    const surface = new cairo.ImageSurface(cairo.Format.ARGB32, size, size);
    const ctx = new cairo.Context(surface);
    ctx.setOperator(cairo.Operator.CLEAR); ctx.paint();
    ctx.setOperator(cairo.Operator.OVER);
    Gdk.cairo_set_source_pixbuf(ctx, pb, 0, 0);
    ctx.paint();
    return surface;
}

function shadowSurface(size, targetPx, origin, dy) {
    const mask = superellipseAlpha(targetPx);
    const canvas = new Float32Array(size * size);
    for (let y = 0; y < targetPx; y++) {
        const ty = y + origin + dy;
        if (ty < 0 || ty >= size) continue;
        for (let x = 0; x < targetPx; x++) {
            const tx = x + origin;
            if (tx < 0 || tx >= size) continue;
            canvas[ty * size + tx] = mask[y * targetPx + x];
        }
    }
    const sigma = Math.max(0.5, size * 0.012);
    const blurred = blurAlpha(canvas, size, sigma);
    const buf = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++)
        buf[i * 4 + 3] = Math.min(255, pyRound(blurred[i] * SHADOW_ALPHA));
    const pb = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, size, size, size * 4);
    return surfaceFromPixbuf(pb, size);
}

const img = GdkPixbuf.Pixbuf.new_from_file(src);
const srcPb = img.get_has_alpha() ? img : img.add_alpha(false, 0, 0, 0);
const metrics = analyze(srcPb);
if (!metrics) { printerr('no opaque core'); System.exit(2); }
const {core, full} = metrics;
const extent = Math.max(core.x1 - core.x0, core.y1 - core.y0);
const results = [];

for (const size of SIZES) {
    const targetPx = pyRound(size * target);
    let scale = pyRound(targetPx * inner) / extent;
    const halfExtent = Math.max(metrics.cx - full.x0, full.x1 - metrics.cx,
                                metrics.cy - full.y0, full.y1 - metrics.cy);
    const safe = (size / 2 - 0.5) / halfExtent;
    const clamped = scale > safe;
    scale = Math.min(scale, safe);

    const crop = srcPb.new_subpixbuf(full.x0, full.y0, full.x1 - full.x0, full.y1 - full.y0);
    const desired = pyRound(targetPx * inner);

    // Plate and shadow are built once per size, from the target plate size.
    const plate = makePlate(targetPx, img);
    const origin = Math.floor((size - targetPx) / 2);
    const shadow = shadowSurface(size, targetPx, origin, Math.max(1, pyRound(size * 0.01)));

    let best = null;
    for (let iter = 0; iter < 4; iter++) {
        const w = Math.max(1, pyRound(crop.get_width() * scale));
        const h = Math.max(1, pyRound(crop.get_height() * scale));
        const scaled = (crop.get_width() === w && crop.get_height() === h)
            ? crop : crop.scale_simple(w, h, GdkPixbuf.InterpType.HYPER);
        const ox = pyRound(size / 2 - (metrics.cx - full.x0) * scale);
        const oy = pyRound(size / 2 - (metrics.cy - full.y0) * scale);

        // Python measures the glyph-only layer; the plate and shadow are
        // composited afterwards and must not influence the measurement.
        const layerSurface = new cairo.ImageSurface(cairo.Format.ARGB32, size, size);
        const lctx = new cairo.Context(layerSurface);
        lctx.setOperator(cairo.Operator.CLEAR); lctx.paint();
        lctx.setOperator(cairo.Operator.OVER);
        Gdk.cairo_set_source_pixbuf(lctx, scaled, ox, oy); lctx.paint();

        const layerPb = Gdk.pixbuf_get_from_surface(layerSurface, 0, 0, size, size);
        const m = analyze(layerPb);
        const measured = m ? pyRound(m.sourceRatio * size) : 0;
        const error = Math.abs(measured - desired);
        if (!best || error < best.error) best = {error, layerSurface, ox, oy, scale, measured};
        if (error === 0 || measured === 0) break;
        const proposed = Math.min(scale * desired / measured, safe);
        if (Math.abs(proposed - scale) < 1e-12) break;
        scale = proposed;
    }

    const out = new cairo.ImageSurface(cairo.Format.ARGB32, size, size);
    const octx = new cairo.Context(out);
    octx.setOperator(cairo.Operator.CLEAR); octx.paint();
    octx.setOperator(cairo.Operator.OVER);
    octx.setSourceSurface(shadow, 0, 0); octx.paint();
    octx.setSourceSurface(surfaceFromPixbuf(plate.pb, targetPx), origin, origin); octx.paint();
    octx.setSourceSurface(best.layerSurface, 0, 0); octx.paint();
    out.writeToPNG(GLib.build_filenamev([outdir, 'gjs-' + size + '.png']));
    results.push({size, measured: best.measured, desired, error: best.error,
                  clamped, plate: plate.kind});
}

print(JSON.stringify({src, cls: 'glyph', results}));