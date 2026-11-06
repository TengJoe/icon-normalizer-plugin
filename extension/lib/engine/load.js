// Source loading, mirroring backend resolver.load_image().
// SVG is rasterized by GdkPixbuf at a fixed size so vector sources produce the
// same pixels as the Python implementation.
// SPDX-License-Identifier: GPL-3.0-or-later

import GdkPixbuf from 'gi://GdkPixbuf';

/** Rasterization size for vector sources; must match resolver.load_image(). */
export const VECTOR_SIZE = 1024;

/**
 * @param {string} path file path
 * @returns {boolean} true for .svg / .svgz
 */
export function isVector(path) {
    return /\.svgz?$/i.test(path);
}

/**
 * Load artwork as a pixbuf with an alpha channel.
 *
 * @param {string} path file path
 * @returns {object} GdkPixbuf with alpha
 */
export function loadPixbuf(path) {
    const pb = isVector(path)
        ? GdkPixbuf.Pixbuf.new_from_file_at_scale(path, VECTOR_SIZE, VECTOR_SIZE, true)
        : GdkPixbuf.Pixbuf.new_from_file(path);
    return pb.get_has_alpha() ? pb : pb.add_alpha(false, 0, 0, 0);
}
