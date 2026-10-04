#!/usr/bin/env node
// Pure-logic unit tests for lib/stateModel.js (no gi imports there).
import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const stateModelUrl = new URL('../../extension/lib/stateModel.js', import.meta.url);
const m = await import(stateModelUrl.href);

const tests = [];
function test(name, fn) {
    tests.push([name, fn]);
}

test('automaticLabel maps all statuses', () => {
    assert.equal(m.automaticLabel({automatic: 'on'}), '已开启');
    assert.equal(m.automaticLabel({automatic: 'partial'}), '部分开启');
    assert.equal(m.automaticLabel({automatic: 'bogus'}), '状态未知');
    assert.equal(m.automaticLabel(null), '状态未知');
});

test('headline covers installed=false, revision and pending', () => {
    assert.equal(m.headline(null).main, '后台状态未知');
    const empty = m.headline({installed: false});
    assert.match(empty.main, /后台未安装/);
    const full = m.headline({
        installed: true,
        automatic: 'on',
        revision: 'a'.repeat(64),
        recovery_pending: true,
        stale: true,
        last_apply_at: '2026-10-02T09:30:00+00:00',
        active_theme: 'DockNormalized',
        summary: {managed_icons: 25},
    });
    assert.match(full.main, /自动维护：已开启/);
    assert.match(full.main, /策略 aaaaaaaa/);
    assert.match(full.main, /有待恢复事务/);
    assert.match(full.main, /结果已过期/);
    assert.match(full.sub, /主题 DockNormalized/);
    assert.match(full.sub, /已管理 25 个图标/);
});

test('badgeFor covers every action', () => {
    const cases = {
        enlarge: '放大', shrink: '缩小', add_plate: '补底板', keep: '保持',
        skipped: '已跳过', excluded: '已排除', unresolved: '待处理',
        retain_previous: '待处理',
    };
    for (const [action, label] of Object.entries(cases)) {
        assert.equal(m.badgeFor({action}).label, label, action);
    }
    assert.equal(m.badgeFor({}).label, '—');
});

test('groupMatchesFilter semantics', () => {
    assert.equal(m.groupMatchesFilter({action: 'enlarge'}, 'changed'), true);
    assert.equal(m.groupMatchesFilter({action: 'shrink'}, 'changed'), true);
    assert.equal(m.groupMatchesFilter({action: 'add_plate'}, 'changed'), false);
    assert.equal(m.groupMatchesFilter({action: 'add_plate'}, 'plate'), true);
    assert.equal(m.groupMatchesFilter({action: 'skipped'}, 'skipped'), true);
    assert.equal(m.groupMatchesFilter({action: 'keep', skipped: true}, 'skipped'), true);
    // default view hides excluded leftovers; they live under their own pill
    assert.equal(m.groupMatchesFilter({action: 'keep'}, 'all'), true);
    assert.equal(m.groupMatchesFilter({action: 'excluded'}, 'all'), false);
    assert.equal(m.groupMatchesFilter({action: 'excluded'}, 'excluded'), true);
    assert.equal(m.groupMatchesFilter({action: 'enlarge'}, 'excluded'), false);
});

test('groupMatchesSearch covers names and icon_name', () => {
    assert.equal(m.groupMatchesSearch({names: ['GIMP'], icon_name: 'gimp'}, 'gim'), true);
    assert.equal(m.groupMatchesSearch({names: ['GIMP'], icon_name: 'gimp'}, 'imp'), true);
    assert.equal(m.groupMatchesSearch({names: ['GIMP'], icon_name: 'gimp'}, 'zed'), false);
    assert.equal(m.groupMatchesSearch({names: ['X']}, ''), true);
});

test('groupSubtitle composes classification and action', () => {
    const sub = m.groupSubtitle({classification: 'plate-rect', action: 'enlarge', target_ratio: 0.88});
    assert.match(sub, /圆角底板/);
    assert.match(sub, /放大/);
});

test('groupSubtitle uses the saved policy and avoids invented defaults', () => {
    assert.match(m.groupSubtitle({classification: 'glyph', action: 'add_plate',
        target_ratio: 0.83, inner_target_ratio: 0.83 * 0.70}), /底板 83% · Logo 58%/);
    assert.equal(m.groupSubtitle({classification: 'glyph', action: 'add_plate'}),
        '单体Logo · 补充底板');
    assert.equal(m.groupSubtitle({classification: 'plate-rect', action: 'enlarge'}),
        '圆角底板 · 放大');
});

test('actionLabel maps known codes and falls back to message', () => {
    assert.match(m.actionLabel({code: 'BUSY'}), /稍后重试/);
    assert.match(m.actionLabel({code: 'REVISION_CONFLICT'}), /刷新/);
    assert.equal(m.actionLabel({code: 'WHATEVER', message: 'custom'}), 'custom');
    assert.equal(m.actionLabel(null), '操作失败');
});

test('operationExitHint distinguishes unconfirmed writes', () => {
    assert.equal(m.operationExitHint(null), '结果尚未确认');
    assert.equal(m.operationExitHint({ok: true}), '');
    assert.match(m.operationExitHint({ok: false, error: {code: 'BUSY'}}), /稍后重试/);
});

test('FILTERS has the six documented pills', () => {
    assert.deepEqual(m.FILTERS.map(f => f.id),
        ['all', 'changed', 'keep', 'skipped', 'plate', 'excluded']);
});

test('backend version gates profile and theme operations', () => {
    for (const [version, expected] of [['3.0.2',false],['3.1.0',true],['3.2.0',true],['4.0.0',true],['invalid',false],[null,false]])
        assert.equal(m.supportsProfilesAndThemes({backend_version:version}),expected);
    assert.equal(m.supportsProfilesAndThemes(null),false);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`FAIL ${name}\n${err.message}`);
    }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
