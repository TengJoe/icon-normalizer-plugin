// User-rule resolution and source classification.
// Port of backend/icon_normalizer/core/classification.py.
//
// Two mechanisms coexist: portable reviewed overrides bound to a source
// fingerprint, and machine-local user rules keyed by icon id. This module
// resolves both and explains the outcome so the UI can report a rule that
// exists but no longer applies.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CLASSES, classify} from './analyze.js';
import {shaHex} from './transaction.js';

export const RULE_STATE_NONE = 'none';
export const RULE_STATE_ACTIVE = 'active';
export const RULE_STATE_STALE = 'stale_source';
export const RULE_STATE_UNBOUND = 'unbound';
export const RULE_STATE_INVALID = 'invalid';

export const ALERT_RULE_STATES = new Set([
    RULE_STATE_STALE, RULE_STATE_UNBOUND, RULE_STATE_INVALID,
]);

/**
 * File name of an icon reference, whether it is a path or a bare theme name.
 *
 * @param {string} value
 * @returns {string}
 */
export function basenameOf(value) {
    const slash = value.lastIndexOf('/');
    return slash < 0 ? value : value.slice(slash + 1);
}

/**
 * Return [rule, matchedBy] with matchedBy in {exact, basename, none}.
 *
 * Exact matches (protocol SHA-256 id, then raw icon string) always win. When
 * neither matches, a rule whose stored key shares the icon's file name is
 * reused: application updates often re-export the same artwork into another
 * size directory. Only an unambiguous single candidate is accepted.
 *
 * @param {Record<string, object>} rules
 * @param {string} icon
 * @param {Record<string, string>} [pathByKey] previous manifest source paths
 * @returns {[object|null, string]}
 */
export function lookupRuleEx(rules, icon, pathByKey = null) {
    const exact = rules[shaHex(icon)] || rules[icon];
    if (exact !== undefined) return [exact, 'exact'];
    const base = basenameOf(icon);
    if (!base) return [null, 'none'];
    const keyPath = key => (pathByKey && pathByKey[key]) ? pathByKey[key] : key;
    const matches = Object.entries(rules).filter(([key]) => basenameOf(keyPath(key)) === base);
    if (matches.length === 1) return [matches[0][1], 'basename'];
    return [null, 'none'];
}

/**
 * Resolve a user rule and explain the outcome.
 *
 * @param {object|null} rule
 * @param {string|null} digest
 * @param {string} matchedBy
 * @returns {[object|null, string, object]} decision, state, detail
 */
export function describeRule(rule, digest, matchedBy = 'exact') {
    if (!rule || rule.reset) return [null, RULE_STATE_NONE, {}];
    if (rule.skip) return [{skip: true, class: null}, RULE_STATE_ACTIVE, {mode: 'skip'}];

    // "class" is accepted as an alias for the portable override schema.
    const cls = rule.classification || rule.class;
    if (rule.classification && rule.class && rule.classification !== rule.class) {
        return [null, RULE_STATE_INVALID, {
            classification: rule.classification,
            class: rule.class,
            reason: 'conflicting_alias',
        }];
    }
    if (cls === 'auto')
        return [{skip: false, class: null, drop_manual: true}, RULE_STATE_ACTIVE, {mode: 'auto'}];
    if (!CLASSES.includes(cls)) return [null, RULE_STATE_INVALID, {classification: cls}];

    const expected = rule.source_sha256;
    if (expected && digest !== expected) {
        const state = digest ? RULE_STATE_STALE : RULE_STATE_UNBOUND;
        return [null, state, {
            expected_sha256: expected, actual_sha256: digest, matched_by: matchedBy,
        }];
    }
    return [{skip: false, class: cls}, RULE_STATE_ACTIVE,
        {classification: cls, matched_by: matchedBy}];
}

/**
 * Classify one source, combining automatic shape analysis, reviewed overrides
 * and machine-local rules.
 *
 * @param {string} icon
 * @param {string} digest
 * @param {object} metrics
 * @param {Record<string, object>} overrides
 * @param {Record<string, object>} rules
 * @param {Record<string, string>} [pathByKey]
 * @returns {{result: object, automatic: string, state: string, detail: object}}
 */
export function classifySourceEx(icon, digest, metrics, overrides, rules, pathByKey = null) {
    const automatic = classify(metrics);
    let result = automatic;

    const override = overrides[icon];
    if (override && digest === override.source_sha256) {
        result = {
            cls: String(override.class),
            reason: String(override.reason || 'reviewed_override'),
            confidence: 'reviewed',
        };
    }

    const [rawRule, matchedBy] = lookupRuleEx(rules, icon, pathByKey);
    const [decision, state, detail] = describeRule(rawRule, digest, matchedBy);
    if (decision) {
        if (decision.drop_manual) {
            result = {cls: automatic.cls, reason: 'automatic_classification',
                confidence: 'automatic'};
        } else if (decision.class) {
            result = {cls: String(decision.class), reason: 'user_classification',
                confidence: 'user'};
        }
    }
    return {result, automatic: automatic.cls, state, detail};
}
