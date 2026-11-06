// Alpha-channel geometry analysis, classification and dead-band planning.
// Port of backend/icon_normalizer/core/analyzer.py; thresholds and the dead-band
// formula are frozen: CORE_ALPHA marks the meaningful core, FULL_ALPHA the outer
// shadow halo, and the +/-2 percentage-point dead band preserves in-tolerance
// vendor artwork untouched.
// SPDX-License-Identifier: GPL-3.0-or-later

import {alphaOf, bboxOf, pyRound} from './util.js';

export const CORE_ALPHA = 200;
export const FULL_ALPHA = 8;

export const CIRCLE_ASPECT_RANGE = [0.95, 1.05];
export const CIRCLE_IOU_MIN = 0.92;
export const RECT_FILL_MIN = 0.86;
export const RECT_RING_MIN = 0.75;

export const CLASSES = ['plate-rect', 'plate-rounded', 'plate-circle', 'artwork', 'glyph'];

/** A plate whose corners stay this opaque is considered square-cornered. */
export const SHARP_CORNER_ALPHA = 0.5;

export class AnalysisError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AnalysisError';
    }
}

/**
 * @typedef {object} IconMetrics
 * @property {number[]} core_bbox [x0, y0, x1, y1], exclusive end
 * @property {number[]} full_bbox same convention, alpha > FULL_ALPHA
 * @property {number} source_ratio longest core edge / canvas
 * @property {number|null} strict_ratio longest edge of alpha > 250, or null
 * @property {number} width_ratio
 * @property {number} height_ratio
 * @property {number} fill fraction of the core box above CORE_ALPHA
 * @property {number} ring fraction of the inset border above CORE_ALPHA
 * @property {number} ellipse_iou IoU with the inscribed ellipse
 * @property {number} aspect
 * @property {number} cx core centre x in image coordinates
 * @property {number} cy core centre y in image coordinates
 * @property {number} corner_alpha mean opacity of the four core-box corners
 */

/**
 * Measure one source image.
 *
 * @param {object} pb GdkPixbuf with or without alpha
 * @returns {IconMetrics}
 */
export function analyze(pb) {
    const {alpha, width, height} = alphaOf(pb);
    const core = bboxOf(alpha, width, height, CORE_ALPHA);
    const full = bboxOf(alpha, width, height, FULL_ALPHA);
    if (!core || !full)
        throw new AnalysisError('Icon has no opaque core');

    const [x0, y0, x1, y1] = core;
    const w = x1 - x0;
    const h = y1 - y0;

    let coreHits = 0;
    for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
            if (alpha[row + x] > CORE_ALPHA) coreHits++;
        }
    }
    const fill = coreHits / (w * h);

    // Inscribed-ellipse IoU over the core box.
    let both = 0, either = 0;
    const halfW = w / 2, halfH = h / 2;
    for (let yy = 0; yy < h; yy++) {
        const ny = ((yy + 0.5 - halfH) / halfH) ** 2;
        const row = (y0 + yy) * width;
        for (let xx = 0; xx < w; xx++) {
            const inside = alpha[row + x0 + xx] > CORE_ALPHA;
            const inEllipse = (((xx + 0.5 - halfW) / halfW) ** 2) + ny <= 1;
            if (inside && inEllipse) both++;
            if (inside || inEllipse) either++;
        }
    }
    const ellipseIou = either ? both / either : 0;

    // Inset border ring: four edges sampled 8% inward.
    const ix = Math.min(w - 1, Math.max(0, pyRound(w * 0.08)));
    const iy = Math.min(h - 1, Math.max(0, pyRound(h * 0.08)));
    const xEnd = Math.max(ix + 1, w - ix);
    const yEnd = Math.max(iy + 1, h - iy);
    let ringHits = 0, ringTotal = 0;
    const sample = (xx, yy) => {
        ringTotal++;
        if (alpha[(y0 + yy) * width + x0 + xx] > CORE_ALPHA) ringHits++;
    };
    for (let xx = ix; xx < xEnd; xx++) { sample(xx, iy); sample(xx, h - 1 - iy); }
    for (let yy = iy; yy < yEnd; yy++) { sample(ix, yy); sample(w - 1 - ix, yy); }
    const ring = ringTotal ? ringHits / ringTotal : 0;

    const strict = bboxOf(alpha, width, height, 250);
    const canvas = Math.max(width, height);

    // Opacity at the four corners of the core box distinguishes a square plate
    // from an already rounded one; the box may be non-square, so sample a small
    // square patch at each corner scaled to the shorter side.
    const patch = Math.max(1, pyRound(Math.min(w, h) * 0.02));
    let cornerSum = 0, cornerCount = 0;
    const corner = (sx, sy) => {
        for (let yy = sy; yy < sy + patch; yy++) {
            for (let xx = sx; xx < sx + patch; xx++) {
                cornerSum += alpha[yy * width + xx];
                cornerCount++;
            }
        }
    };
    corner(x0, y0);
    corner(Math.max(x0, x1 - patch), y0);
    corner(x0, Math.max(y0, y1 - patch));
    corner(Math.max(x0, x1 - patch), Math.max(y0, y1 - patch));
    const cornerAlpha = cornerCount ? (cornerSum / cornerCount) / 255 : 1.0;

    return {
        core_bbox: core,
        full_bbox: full,
        source_ratio: Math.max(w, h) / canvas,
        strict_ratio: strict ? Math.max(strict[2] - strict[0], strict[3] - strict[1]) / canvas : null,
        width_ratio: w / canvas,
        height_ratio: h / canvas,
        fill,
        ring,
        ellipse_iou: ellipseIou,
        aspect: w / h,
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2,
        corner_alpha: cornerAlpha,
    };
}

/**
 * Shape descriptors suggest a class; they do not prove a semantic plate.
 *
 * @param {IconMetrics} metrics
 * @returns {{cls: string, reason: string, confidence: string}}
 */
export function classify(metrics) {
    if (metrics.aspect >= CIRCLE_ASPECT_RANGE[0] && metrics.aspect <= CIRCLE_ASPECT_RANGE[1]
            && metrics.ellipse_iou >= CIRCLE_IOU_MIN)
        return {cls: 'plate-circle', reason: 'ellipse_silhouette', confidence: 'high'};
    if (metrics.fill >= RECT_FILL_MIN && metrics.ring >= RECT_RING_MIN)
        return {cls: 'plate-rect', reason: 'filled_silhouette', confidence: 'medium'};
    return {cls: 'artwork', reason: 'ambiguous_preserve_artwork', confidence: 'review'};
}

/**
 * Suggest a class the automatic table cannot prove on its own.
 *
 * A filled rectangular plate with fully opaque corners is a square plate; on a
 * rounded desktop grid that reads as broken. The suggestion is advisory only --
 * applying it requires an explicit per-icon rule.
 *
 * @param {IconMetrics} metrics
 * @returns {string|null}
 */
export function suggestClass(metrics) {
    if (metrics.fill >= RECT_FILL_MIN && metrics.ring >= RECT_RING_MIN
            && metrics.corner_alpha >= SHARP_CORNER_ALPHA)
        return 'plate-rounded';
    return null;
}

/**
 * Decide the action for one icon under the target/dead-band policy.
 *
 * @param {IconMetrics} metrics
 * @param {string} cls
 * @param {number} target
 * @param {number} deadband
 * @param {number} inner
 * @returns {{action: string, reason: string, target_ratio: number,
 *            inner_target_ratio: number|null, scale: number}}
 */
export function plan(metrics, cls, target = 0.88, deadband = 0.02, inner = 0.72) {
    const src = metrics.source_ratio;
    if (cls === 'glyph') {
        return {
            action: 'add_plate',
            reason: 'reviewed_glyph',
            target_ratio: target,
            inner_target_ratio: target * inner,
            scale: target * inner / src,
        };
    }
    if (src >= target - deadband - 1e-9 && src <= target + deadband + 1e-9) {
        return {
            action: 'keep',
            reason: 'within_deadband',
            target_ratio: target,
            inner_target_ratio: null,
            scale: 1.0,
        };
    }
    return {
        action: src < target ? 'enlarge' : 'shrink',
        reason: 'outside_deadband',
        target_ratio: target,
        inner_target_ratio: null,
        scale: target / src,
    };
}
