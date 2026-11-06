// Shared pixel helpers for the GJS engine.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Python's round() rounds half to even; Math.round always rounds .5 up.
 * The renderer's placement offset lands exactly on .5 for some sizes, so every
 * rounding step in this engine goes through here.
 *
 * @param {number} x value to round
 * @returns {number} nearest integer, ties to even
 */
export function pyRound(x) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return (floor % 2 === 0) ? floor : floor + 1;
}

/**
 * Read a pixbuf's geometry and backing bytes without copying.
 *
 * @param {object} pb GdkPixbuf
 * @returns {{width: number, height: number, rowstride: number, channels: number, data: Uint8Array}}
 */
export function pixelsOf(pb) {
    return {
        width: pb.get_width(),
        height: pb.get_height(),
        rowstride: pb.get_rowstride(),
        channels: pb.get_n_channels(),
        data: pb.get_pixels(),
    };
}

/**
 * Alpha channel of a pixbuf as one byte per pixel (255 where the source has no
 * alpha channel, matching PIL's convert("RGBA")).
 *
 * @param {object} pb GdkPixbuf
 * @returns {{alpha: Uint8Array, width: number, height: number}}
 */
export function alphaOf(pb) {
    const {width, height, rowstride, channels, data} = pixelsOf(pb);
    const alpha = new Uint8Array(width * height);
    if (channels === 4) {
        for (let y = 0; y < height; y++) {
            const row = y * rowstride;
            const out = y * width;
            for (let x = 0; x < width; x++)
                alpha[out + x] = data[row + x * 4 + 3];
        }
    } else {
        alpha.fill(255);
    }
    return {alpha, width, height};
}

/**
 * Half-open bounding box of pixels above a threshold.
 *
 * @param {Uint8Array} alpha one byte per pixel
 * @param {number} width image width
 * @param {number} height image height
 * @param {number} threshold exclusive lower bound
 * @returns {number[]|null} [x0, y0, x1, y1] with x1/y1 exclusive, or null
 */
export function bboxOf(alpha, width, height, threshold) {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (alpha[row + x] <= threshold) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return null;
    return [x0, y0, x1 + 1, y1 + 1];
}
