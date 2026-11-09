// Record that the in-process engine owns this theme directory.
//
// The Python worker stays in the tree as the parity oracle, but a second
// renderer writing the same theme makes both sides rewrite every managed file
// (their PNG bytes differ by a few levels at anti-aliased edges). The marker
// is what backend/icon_normalizer/renderer_owner.py reads to refuse writes.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {atomicWrite} from './engine/transaction.js';

/** Owner value the Python guard recognises. */
export const GJS_OWNER = 'gjs';

/**
 * Claim the state directory for the in-process engine.
 *
 * @param {string} stateDir icon-normalizer state directory
 */
export function claimRendererOwnership(stateDir) {
    const path = GLib.build_filenamev([stateDir, 'renderer.json']);
    const document = {schema_version: 1, owner: GJS_OWNER};
    atomicWrite(path, new TextEncoder().encode(JSON.stringify(document, null, 2)), 0o600);
}
