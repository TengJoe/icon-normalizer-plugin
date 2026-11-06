// GJS feasibility prototype: mirror the Python analyzer + renderer (non-glyph path).
// usage: gjs -m render.js <src.png> <outdir> <class> <target> <inner>
import GdkPixbuf from 'gi://GdkPixbuf';
import Gdk from 'gi://Gdk?version=3.0';
import cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import System from 'system';

const [src, outdir, cls = 'artwork', targetS = '0.83', innerS = '0.7'] = ARGV;
const target = Number(targetS);
const inner = Number(innerS);
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];
const CORE_ALPHA = 200;
const FULL_ALPHA = 8;

// Python's round() rounds half to even; Math.round always rounds .5 up.
// The placement offset lands exactly on .5 for some sizes, so match Python.
function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
}

function analyze(pb) {
    const w = pb.get_width(), h = pb.get_height();
    const rs = pb.get_rowstride();
    const px = pb.get_pixels();
    const nch = pb.get_n_channels();
    let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
    let fx0 = w, fy0 = h, fx1 = -1, fy1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const a = nch === 4 ? px[y * rs + x * 4 + 3] : 255;
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
    // Python bbox_of returns half-open [x0, x1) semantics for slicing.
    const core = {x0: cx0, y0: cy0, x1: cx1 + 1, y1: cy1 + 1};
    const full = {x0: fx0, y0: fy0, x1: fx1 + 1, y1: fy1 + 1};
    const w2 = core.x1 - core.x0, h2 = core.y1 - core.y0;
    return {
        core, full,
        sourceRatio: Math.max(w2, h2) / Math.max(w, h),
        cx: (core.x0 + core.x1) / 2,
        cy: (core.y0 + core.y1) / 2,
    };
}

function cropPixbuf(pb, b) {
    return pb.new_subpixbuf(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
}

function scaledPixbuf(pb, w, h) {
    if (pb.get_width() === w && pb.get_height() === h) return pb;
    return pb.scale_simple(w, h, GdkPixbuf.InterpType.HYPER);
}

function composite(size, pb, ox, oy) {
    const surface = new cairo.ImageSurface(cairo.Format.ARGB32, size, size);
    const ctx = new cairo.Context(surface);
    ctx.setOperator(cairo.Operator.CLEAR);
    ctx.paint();
    ctx.setOperator(cairo.Operator.OVER);
    Gdk.cairo_set_source_pixbuf(ctx, pb, ox, oy);
    ctx.paint();
    return surface;
}

function surfaceToPixbuf(surface, size) {
    return Gdk.pixbuf_get_from_surface(surface, 0, 0, size, size);
}

// Mirror resolver.load_image(): SVG is rasterized by GdkPixbuf at 1024 px,
// raster sources are read as-is.
const isVector = /\.svgz?$/i.test(src);
const img = isVector
    ? GdkPixbuf.Pixbuf.new_from_file_at_scale(src, 1024, 1024, true)
    : GdkPixbuf.Pixbuf.new_from_file(src);
const srcPb = img.get_has_alpha()
    ? img
    : img.add_alpha(false, 0, 0, 0);
const metrics = analyze(srcPb);
if (!metrics) {
    printerr('no opaque core');
    System.exit(2);
}

const core = metrics.core, full = metrics.full;
const extent = Math.max(core.x1 - core.x0, core.y1 - core.y0);
const results = [];

for (const size of SIZES) {
    const targetPx = pyRound(size * target);
    let scale = (cls === 'glyph' ? pyRound(targetPx * inner) : targetPx) / extent;
    const halfExtent = Math.max(
        metrics.cx - full.x0, full.x1 - metrics.cx,
        metrics.cy - full.y0, full.y1 - metrics.cy);
    const safe = (size / 2 - 0.5) / halfExtent;
    const clamped = scale > safe;
    scale = Math.min(scale, safe);
    const crop = cropPixbuf(srcPb, full);
    const desired = cls === 'glyph' ? pyRound(targetPx * inner) : targetPx;

    let best = null;
    for (let iter = 0; iter < 4; iter++) {
        const w = Math.max(1, pyRound(crop.get_width() * scale));
        const h = Math.max(1, pyRound(crop.get_height() * scale));
        const scaled = scaledPixbuf(crop, w, h);
        const ox = pyRound(size / 2 - (metrics.cx - full.x0) * scale);
        const oy = pyRound(size / 2 - (metrics.cy - full.y0) * scale);
        const surface = composite(size, scaled, ox, oy);
        const layerPb = surfaceToPixbuf(surface, size);
        const m = analyze(layerPb);
        const measured = m ? pyRound(m.sourceRatio * size) : 0;
        const error = Math.abs(measured - desired);
        if (!best || error < best.error) best = {error, surface, scale, measured};
        if (error === 0 || measured === 0) break;
        const proposed = Math.min(scale * desired / measured, safe);
        if (Math.abs(proposed - scale) < 1e-12) break;
        scale = proposed;
    }

    const outPath = GLib.build_filenamev([outdir, 'gjs-' + size + '.png']);
    best.surface.writeToPNG(outPath);
    results.push({size, measured: best.measured, desired, error: best.error, clamped});
}

print(JSON.stringify({src, cls, results}));