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
export async function runApplyFlow(controlPath, {activate = null, scope = null, onProgress = null} = {}) {
    const statusEnvelope = await call(controlPath, 'status', {}, scope);
    if (!statusEnvelope.ok) {
        return {status: statusEnvelope, apply: null, after: null};
    }
    if (scope?.closed) return {status: statusEnvelope, apply: null, after: null};
    const status = statusEnvelope.result;
    if (!status.revision) {
        return {status: statusEnvelope, apply: null, after: null};
    }
    const shouldActivate = activate === null ? status.overlay_in_use === false : activate;
    const applyEnvelope = await call(controlPath, 'apply', {
        expected_revision: status.revision,
        activate: shouldActivate,
        // Functions cannot cross the process boundary; the local backend uses
        // it for progress and the Python worker simply never sees it.
        ...(typeof onProgress === 'function' ? {onProgress} : {}),
    }, scope);
    const after = scope?.closed ? null : await call(controlPath, 'status', {}, scope);
    // The file transaction and the theme switch commit separately. Surface the
    // second one so "applied but still inactive" can never look like success.
    const afterStatus = after?.ok ? after.result : null;
    const observed = afterStatus?.overlay_in_use;
    const themeActive = typeof observed === 'boolean' ? observed : null;
    const activation = applyEnvelope?.ok ? applyEnvelope.result?.theme_activation ?? null : null;
    const activationFailed = Boolean(shouldActivate && applyEnvelope?.ok &&
        (themeActive === false || ['unavailable', 'superseded'].includes(activation)));
    return {
        status: statusEnvelope,
        apply: applyEnvelope,
        after,
        hint: operationExitHint(applyEnvelope),
        activate: shouldActivate,
        activation,
        themeActive,
        activationFailed,
        activationUnconfirmed: Boolean(shouldActivate && applyEnvelope?.ok &&
            !activationFailed && themeActive === null),
    };
}
