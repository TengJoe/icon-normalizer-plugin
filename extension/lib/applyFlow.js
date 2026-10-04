// SPDX-License-Identifier: GPL-3.0-or-later
// The status→apply→status choreography, shared by the panel indicator and the
// maintenance page (single implementation; ADR-0003 §6).
import {call} from './backendClient.js';
import {operationExitHint} from './stateModel.js';

/**
 * Read the current revision, apply the policy, then re-read status.
 *
 * `activate` defaults to "switch the global theme only when the overlay is not
 * already in use", matching the panel's historical behavior; the maintenance
 * page passes explicit true/false from the button the user clicked.
 */
export async function runApplyFlow(controlPath, {activate = null, requestId = 'apply-flow', scope = null} = {}) {
    const statusEnvelope = await call(controlPath, 'status', {}, scope);
    if (!statusEnvelope.ok) {
        return {status: statusEnvelope, apply: null, after: null};
    }
    const status = statusEnvelope.result;
    if (!status.revision) {
        return {status: statusEnvelope, apply: null, after: null};
    }
    const shouldActivate = activate === null ? status.overlay_in_use === false : activate;
    const applyEnvelope = await call(controlPath, 'apply', {
        expected_revision: status.revision,
        activate: shouldActivate,
    }, scope);
    const after = await call(controlPath, 'status', {}, scope);
    return {
        status: statusEnvelope,
        apply: applyEnvelope,
        after,
        hint: operationExitHint(applyEnvelope),
        activate: shouldActivate,
        requestId,
    };
}
