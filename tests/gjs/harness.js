// Minimal assertion harness for GJS unit tests (no Node, no external deps).
// SPDX-License-Identifier: GPL-3.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import System from 'system';

let passed = 0;
let failed = 0;
const pending = [];

export function test(name, fn) {
    let result;
    try {
        result = fn();
    } catch (error) {
        failed++;
        print('  FAIL ' + name);
        print('       ' + (error && error.message || error));
        return;
    }
    // Async tests settle here: without this, a rejected promise used to be
    // counted as a pass and only surfaced as an unhandled-rejection warning.
    if (result && typeof result.then === 'function') {
        pending.push(result.then(() => {
            passed++;
            print('  ok   ' + name);
        }, error => {
            failed++;
            print('  FAIL ' + name);
            print('       ' + (error && error.message || error));
        }));
        return;
    }
    passed++;
    print('  ok   ' + name);
}

export function assertEqual(actual, expected, what = 'value') {
    if (actual !== expected)
        throw new Error(what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

export function assertClose(actual, expected, epsilon, what = 'value') {
    if (!(Math.abs(actual - expected) <= epsilon))
        throw new Error(what + ': expected ' + expected + ' +/- ' + epsilon + ', got ' + actual);
}

export function assertTrue(value, what = 'condition') {
    if (!value) throw new Error(what + ': expected truthy, got ' + JSON.stringify(value));
}

export function assertNull(value, what = 'value') {
    if (value !== null) throw new Error(what + ': expected null, got ' + JSON.stringify(value));
}

/**
 * Build a pixbuf from a predicate over pixel coordinates.
 *
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => number} alphaOf alpha 0-255
 * @returns {object} GdkPixbuf with alpha
 */
export function pixbufFromAlpha(width, height, alphaOf) {
    const buf = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            buf[i] = 40;
            buf[i + 1] = 40;
            buf[i + 2] = 40;
            buf[i + 3] = alphaOf(x, y);
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(buf),
        GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
}

export async function report() {
    await Promise.all(pending);
    const total = passed + failed;
    print(passed + '/' + total + ' passed');
    if (failed > 0) System.exit(1);
}
