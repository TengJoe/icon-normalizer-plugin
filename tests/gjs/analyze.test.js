// Unit tests for the GJS analyzer. Run: gjs -m tests/gjs/analyze.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import {
    analyze, classify, plan, suggestClass, AnalysisError,
    CORE_ALPHA,
} from '../../extension/lib/engine/analyze.js';
import {bboxOf, pyRound} from '../../extension/lib/engine/util.js';
import {
    test, assertEqual, assertClose, assertTrue, assertNull, pixbufFromAlpha, report,
} from './harness.js';

const opaque = () => 255;
const clear = () => 0;

test('pyRound ties go to even, like Python round()', () => {
    assertEqual(pyRound(0.5), 0, '0.5');
    assertEqual(pyRound(1.5), 2, '1.5');
    assertEqual(pyRound(2.5), 2, '2.5');
    assertEqual(pyRound(15.5), 16, '15.5');
    assertEqual(pyRound(14.5), 14, '14.5');
    assertEqual(pyRound(2.4), 2, '2.4');
    assertEqual(pyRound(2.6), 3, '2.6');
});

test('bboxOf returns a half-open box and null when nothing passes', () => {
    const alpha = new Uint8Array(10 * 10);
    for (let y = 2; y < 6; y++)
        for (let x = 3; x < 8; x++) alpha[y * 10 + x] = 255;
    assertEqual(JSON.stringify(bboxOf(alpha, 10, 10, CORE_ALPHA)), '[3,2,8,6]', 'box');
    assertNull(bboxOf(alpha, 10, 10, 255), 'threshold above every pixel');
});

test('a fully opaque square measures 1.0 coverage with no ellipse match', () => {
    const metrics = analyze(pixbufFromAlpha(64, 64, opaque));
    assertClose(metrics.source_ratio, 1.0, 1e-12, 'source_ratio');
    assertClose(metrics.fill, 1.0, 1e-12, 'fill');
    assertClose(metrics.ring, 1.0, 1e-12, 'ring');
    assertClose(metrics.corner_alpha, 1.0, 1e-12, 'corner_alpha');
    // A square's inscribed ellipse covers pi/4; discrete sampling lands a
    // little above that, so allow half a percent.
    assertClose(metrics.ellipse_iou, Math.PI / 4, 5e-3, 'ellipse_iou');
    assertEqual(JSON.stringify(metrics.core_bbox), '[0,0,64,64]', 'core_bbox');
});

test('an inscribed circle reads as plate-circle', () => {
    const size = 64, r = size / 2;
    const metrics = analyze(pixbufFromAlpha(size, size, (x, y) =>
        (((x + 0.5 - r) / r) ** 2 + ((y + 0.5 - r) / r) ** 2) <= 1 ? 255 : 0));
    const result = classify(metrics);
    assertEqual(result.cls, 'plate-circle', 'class');
    assertEqual(result.confidence, 'high', 'confidence');
});

test('a fully opaque square reads as plate-rect', () => {
    const result = classify(analyze(pixbufFromAlpha(64, 64, opaque)));
    assertEqual(result.cls, 'plate-rect', 'class');
});

test('a solid rectangle stays a plate regardless of size', () => {
    const metrics = analyze(pixbufFromAlpha(64, 64, (x, y) =>
        (x > 20 && x < 44 && y > 28 && y < 36) ? 255 : 0));
    assertEqual(classify(metrics).cls, 'plate-rect', 'class');
});

test('two disjoint blobs read as artwork', () => {
    // Low fill and no ellipse match: neither plate shape can be proven.
    const metrics = analyze(pixbufFromAlpha(64, 64, (x, y) =>
        ((x >= 5 && x < 15 && y >= 5 && y < 15) ||
         (x >= 49 && x < 59 && y >= 49 && y < 59)) ? 255 : 0));
    assertEqual(classify(metrics).cls, 'artwork', 'class');
});

test('a square plate with opaque corners suggests plate-rounded', () => {
    const suggestion = suggestClass(analyze(pixbufFromAlpha(64, 64, opaque)));
    assertEqual(suggestion, 'plate-rounded', 'suggestion');
});

test('a circle does not suggest plate-rounded', () => {
    const size = 64, r = size / 2;
    const metrics = analyze(pixbufFromAlpha(size, size, (x, y) =>
        (((x + 0.5 - r) / r) ** 2 + ((y + 0.5 - r) / r) ** 2) <= 1 ? 255 : 0));
    assertNull(suggestClass(metrics), 'suggestion');
});

test('plan keeps in-tolerance artwork and moves out-of-tolerance artwork', () => {
    const at = ratio => ({source_ratio: ratio});
    assertEqual(plan(at(0.83), 'artwork', 0.83, 0.02, 0.7).action, 'keep', 'exact target');
    assertEqual(plan(at(0.85), 'artwork', 0.83, 0.02, 0.7).action, 'keep', 'upper dead band edge');
    assertEqual(plan(at(0.81), 'artwork', 0.83, 0.02, 0.7).action, 'keep', 'lower dead band edge');
    assertEqual(plan(at(0.90), 'artwork', 0.83, 0.02, 0.7).action, 'shrink', 'above');
    assertEqual(plan(at(0.70), 'artwork', 0.83, 0.02, 0.7).action, 'enlarge', 'below');
    const glyph = plan(at(0.60), 'glyph', 0.83, 0.02, 0.7);
    assertEqual(glyph.action, 'add_plate', 'glyph action');
    assertClose(glyph.scale, 0.83 * 0.7 / 0.60, 1e-12, 'glyph scale');
});

test('an image with no opaque core is rejected', () => {
    let threw = false;
    try {
        analyze(pixbufFromAlpha(16, 16, clear));
    } catch (error) {
        threw = error instanceof AnalysisError;
    }
    assertTrue(threw, 'AnalysisError');
});

test('thresholds separate the core from the shadow halo', () => {
    const metrics = analyze(pixbufFromAlpha(32, 32, (x, y) =>
        (x < 4 || y < 4 || x > 27 || y > 27) ? 100 : 255));
    assertEqual(JSON.stringify(metrics.full_bbox), '[0,0,32,32]', 'full_bbox');
    assertEqual(JSON.stringify(metrics.core_bbox), '[4,4,28,28]', 'core_bbox');
    assertTrue(metrics.source_ratio < 1.0, 'core smaller than canvas');
});

report();
