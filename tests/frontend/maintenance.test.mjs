// Exercise production maintenance and apply-flow logic with controlled responses.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';

const root = new URL('../../extension/', import.meta.url);
const context = createContext({console});
const responses = [];
const calls = [];
const mocks = {
    'gi://Gtk': {default: {}}, 'gi://Adw': {default: {}},
    [new URL('shared/backendClient.js', root).href]: {call: async (_path, operation) => {
        calls.push(operation);
        const response = responses.shift();
        if (!response) throw new Error(`Unexpected ${operation} request`);
        return await response;
    }},
    [new URL('prefs/requestScope.js', root).href]: {WindowScope: class {}},
    [new URL('prefs/about.js', root).href]: {About: class {}},
    [new URL('prefs/uiCommon.js', root).href]: Object.fromEntries([
        'actionButton', 'actionGroup', 'bindSwitch', 'configurePage', 'noticeRow', 'statusBadge', 'toast',
    ].map(name => [name, () => {}])),
};
const modules = new Map();
function module(id) {
    if (modules.has(id)) return modules.get(id);
    const values = mocks[id];
    const result = values ? new SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, {context, identifier: id}) : new SourceTextModule(readFileSync(new URL(id), 'utf8'), {context, identifier: id});
    modules.set(id, result);
    return result;
}
const entry = module(new URL('prefs/maintenancePage.js', root).href);
await entry.link((name, parent) => module(name.startsWith('.') ? new URL(name, parent.identifier).href : name));
await entry.evaluate();
const {MaintenancePage} = entry.namespace;
const {runApplyFlow} = modules.get(new URL('shared/applyFlow.js', root).href).namespace;
function widget() {
    return {set_text(value) {this.text = value;}, set_tooltip_text(value) {this.tooltip = value;},
        set_css_classes(value) {this.css = value;}, set_subtitle(value) {this.subtitle = value;},
        set_visible(value) {this.visible = value;}, set_sensitive(value) {this.sensitive = value;}};
}
function page() {
    const result = Object.create(MaintenancePage.prototype);
    result._scope = {closed: false}; result._controlPath = '/fixture-only'; result._refreshGeneration = 0;
    result._opNotice = {show(text, options) {this.text = text; this.options = options;}};
    result._themeNotice = {hide() {this.visible = false;}, show(text) {this.visible = true; this.text = text;}};
    for (const name of ['_badgeHealth', '_rowHealth', '_healthDetails', '_rowHealthDetails', '_rowChecked',
        '_rowUpdated', '_rowTheme', '_badgeVersion', '_badgeTheme', '_badgeManaged', '_badgeAuto', '_lblRev',
        '_autoRow', '_followRow', '_btnScan', '_btnApply', '_btnActivate', '_btnRevert']) result[name] = widget();
    result._setAuto = value => {result.automaticToggle = value;}; result._setFollow = () => {};
    return result;
}
const healthy = {ok: true, result: {installed: true, backend_version: '3.1.6', revision: 'a'.repeat(64),
    automatic: 'on', theme_follow: true, overlay_in_use: true, last_check_at: '2026-11-02T00:00:00Z',
    summary: {managed_icons: 1}}};
const inactive = {ok: true, result: {...healthy.result, overlay_in_use: false}};
const ioError = {ok: false, error: {code: 'IO_ERROR'}};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('preflight dependency failure is shown and no apply starts', async () => {
    const target = page(); calls.length = 0;
    responses.push({ok: false, error: {code: 'DEPENDENCY_MISSING'}});
    await target._apply(false);
    assert.match(target._opNotice.text, /后端依赖缺失/);
    assert.deepEqual(calls, ['status']);
});

test('failed refresh marks data unknown and disables uncertain switches', async () => {
    const target = page(); responses.push(healthy); await target.refresh();
    assert.equal(target._badgeHealth.text, '成功');
    responses.push(ioError); await target.refresh();
    assert.equal(target._badgeHealth.text, '未知');
    assert.equal(target._badgeTheme.text, '未知');
    assert.equal(target._badgeAuto.text, '状态未知');
    assert.equal(target._autoRow.sensitive, false);
    assert.equal(target._followRow.sensitive, false);
    assert.equal(target._opNotice.text, '后端通信失败');
    responses.push(healthy); await target.refresh();
    assert.equal(target._badgeHealth.text, '成功');
    assert.equal(target._autoRow.sensitive, true);
});

test('out-of-order status and stale failures cannot overwrite a newer response', async () => {
    const target = page(); let release;
    responses.push(new Promise(resolve => {release = resolve;}));
    const old = target.refresh(); responses.push(healthy); await target.refresh();
    release({...healthy, result: {...healthy.result, automatic: 'off'}}); await old;
    assert.equal(target.automaticToggle, true);
    let releaseFailure;
    responses.push(new Promise(resolve => {releaseFailure = resolve;}));
    const oldFailure = target.refresh(); responses.push(healthy); await target.refresh();
    releaseFailure(ioError); await oldFailure;
    assert.equal(target._badgeHealth.text, '成功');
    assert.equal(target._opNotice.text, undefined);
});

test('unknown theme status remains unknown rather than becoming inactive', async () => {
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'applied'}},
        {ok: true, result: {overlay_in_use: null}});
    const flow = await runApplyFlow('/fixture-only', {activate: true});
    assert.equal(flow.themeActive, null);
    assert.equal(flow.activationFailed, false);
    assert.equal(flow.activationUnconfirmed, true);
});

test('backend activation failure survives a failed follow-up status', async () => {
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'unavailable'}}, ioError);
    const flow = await runApplyFlow('/fixture-only', {activate: true});
    assert.equal(flow.themeActive, null);
    assert.equal(flow.activationFailed, true);
});

test('activation failure remains visible if both status reads fail', async () => {
    const target = page(); responses.push(healthy); await target.refresh();
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'unavailable'}},
        ioError, ioError);
    await target._apply(true);
    assert.match(target._opNotice.text, /激活未完成/);
    assert.match(target._opNotice.text, /后台状态读取失败/);
    assert.equal(target._opNotice.options.error, true);
    assert.equal(target._badgeHealth.text, '未知');
});

test('confirmed inactive, successful activation and rerender report distinct outcomes', async () => {
    const target = page();
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'unavailable'}}, inactive, inactive);
    await target._apply(true);
    assert.match(target._opNotice.text, /仍未激活/);
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'applied'}}, healthy, healthy);
    await target._apply(true);
    assert.match(target._opNotice.text, /主题已激活/);
    responses.push(inactive, {ok: true, result: {file_operations: 1, theme_activation: 'not_requested'}}, inactive, inactive);
    await target._apply(false);
    assert.doesNotMatch(target._opNotice.text, /主题已激活/);
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'unavailable'}}, healthy, healthy);
    await target._apply(true);
    assert.match(target._opNotice.text, /本次激活未完成（当前主题已生效）/);
});

test('apply preserves the warning for partial automation', async () => {
    const target = page();
    const partial = {...healthy, result: {...healthy.result, automatic: 'partial'}};
    responses.push(inactive, {ok: true, result: {file_operations: 0, theme_activation: 'applied'}}, healthy, partial);
    await target._apply(true);
    assert.match(target._opNotice.text, /部分自动维护触发器未开启/);
    assert.equal(target._opNotice.options.error, true);
});

let failures = 0;
for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
assert.equal(responses.length, 0, 'unconsumed backend fixtures');
console.log(`${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
