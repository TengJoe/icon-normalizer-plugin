// Unit tests for user-rule resolution and source classification.
// Run: gjs -m tests/gjs/classification.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import {
    lookupRuleEx, describeRule, classifySourceEx,
    RULE_STATE_ACTIVE, RULE_STATE_STALE, RULE_STATE_UNBOUND, RULE_STATE_INVALID,
    RULE_STATE_NONE, ALERT_RULE_STATES,
} from '../../extension/lib/engine/classification.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

const metrics = {aspect: 1.0, ellipse_iou: 0.5, fill: 1.0, ring: 1.0, corner_alpha: 1.0};

test('an exact rule beats a basename rule', () => {
    const rules = {
        'example.png': {classification: 'glyph'},
        'other/example.png': {classification: 'artwork'},
    };
    const [rule, matchedBy] = lookupRuleEx(rules, 'example.png');
    assertEqual(matchedBy, 'exact', 'matched by');
    assertEqual(rule.classification, 'glyph', 'rule');
});

test('a unique basename match is reused across size directories', () => {
    const rules = {'/icons/256x256/apps/example.png': {classification: 'glyph'}};
    const [rule, matchedBy] = lookupRuleEx(rules, '/icons/512x512/apps/example.png');
    assertEqual(matchedBy, 'basename', 'matched by');
    assertEqual(rule.classification, 'glyph', 'rule');
});

test('an ambiguous basename match is refused', () => {
    const rules = {
        '/a/example.png': {classification: 'glyph'},
        '/b/example.png': {classification: 'artwork'},
    };
    const [rule, matchedBy] = lookupRuleEx(rules, '/c/example.png');
    assertEqual(rule, null, 'no rule');
    assertEqual(matchedBy, 'none', 'matched by');
});

test('path_by_key recovers a file name from a protocol digest key', () => {
    const rules = {abc123: {classification: 'glyph'}};
    const [rule, matchedBy] = lookupRuleEx(rules, '/icons/example.png',
        {abc123: '/icons/256x256/apps/example.png'});
    assertEqual(matchedBy, 'basename', 'matched by');
    assertEqual(rule.classification, 'glyph', 'rule');
});

test('describeRule reports every rule state', () => {
    assertEqual(describeRule(null, 'd')[1], RULE_STATE_NONE, 'no rule');
    assertEqual(describeRule({reset: true}, 'd')[1], RULE_STATE_NONE, 'reset');

    const [skip, skipState] = describeRule({skip: true}, 'd');
    assertEqual(skip.skip, true, 'skip decision');
    assertEqual(skipState, RULE_STATE_ACTIVE, 'skip state');

    assertEqual(describeRule({classification: 'glyph'}, 'd')[1], RULE_STATE_ACTIVE, 'active');
    assertEqual(describeRule({classification: 'auto'}, 'd')[0].drop_manual, true, 'auto');
    assertEqual(describeRule({classification: 'nonsense'}, 'd')[1], RULE_STATE_INVALID, 'bad class');

    const [conflict, conflictState] = describeRule(
        {classification: 'glyph', class: 'artwork'}, 'd');
    assertEqual(conflict, null, 'conflicting alias decision');
    assertEqual(conflictState, RULE_STATE_INVALID, 'conflicting alias state');

    assertEqual(describeRule({classification: 'glyph', source_sha256: 'other'}, 'd')[1],
        RULE_STATE_STALE, 'stale when the digest differs');
    assertEqual(describeRule({classification: 'glyph', source_sha256: 'x'}, null)[1],
        RULE_STATE_UNBOUND, 'unbound without a digest');
    assertEqual(describeRule({classification: 'glyph', source_sha256: 'd'}, 'd')[1],
        RULE_STATE_ACTIVE, 'bound');
});

test('the class alias is accepted for portable overrides', () => {
    const [decision, state] = describeRule({class: 'glyph'}, 'd');
    assertEqual(decision.class, 'glyph', 'class alias');
    assertEqual(state, RULE_STATE_ACTIVE, 'state');
});

test('alert states are exactly stale, unbound and invalid', () => {
    assertEqual(ALERT_RULE_STATES.size, 3, 'size');
    assertTrue(ALERT_RULE_STATES.has(RULE_STATE_STALE), 'stale');
    assertTrue(!ALERT_RULE_STATES.has(RULE_STATE_ACTIVE), 'active is not an alert');
});

test('a reviewed override outranks the automatic class', () => {
    const result = classifySourceEx('example', 'digest',
        {aspect: 1.0, ellipse_iou: 0.99, fill: 0.5, ring: 0.5, corner_alpha: 0.0},
        {example: {class: 'artwork', source_sha256: 'digest'}}, {});
    assertEqual(result.result.cls, 'artwork', 'override wins');
    assertEqual(result.result.confidence, 'reviewed', 'confidence');
    assertEqual(result.automatic, 'plate-circle', 'automatic kept');
});

test('a user rule outranks a reviewed override', () => {
    const result = classifySourceEx('example', 'digest', metrics,
        {example: {class: 'artwork', source_sha256: 'digest'}},
        {example: {classification: 'glyph'}});
    assertEqual(result.result.cls, 'glyph', 'user rule wins');
    assertEqual(result.result.confidence, 'user', 'confidence');
});

test('an auto rule restores the automatic classification', () => {
    const result = classifySourceEx('example', 'digest', metrics,
        {example: {class: 'artwork', source_sha256: 'digest'}},
        {example: {classification: 'auto'}});
    assertEqual(result.result.cls, result.automatic, 'automatic restored');
    assertEqual(result.result.confidence, 'automatic', 'confidence');
});

test('a stale rule falls back to the automatic class and is reported', () => {
    const result = classifySourceEx('example', 'new-digest', metrics, {},
        {example: {classification: 'glyph', source_sha256: 'old-digest'}});
    assertEqual(result.result.cls, result.automatic, 'falls back');
    assertEqual(result.state, RULE_STATE_STALE, 'state');
});

await report();
