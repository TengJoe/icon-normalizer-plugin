// Load the production entry, indicator and apply flow with only external
// Shell/GI/backend boundaries doubled. No source rewrites or copied methods.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const extensionRoot = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]) + '/')
    : new URL('../../extension/', import.meta.url);

class Signals {
    constructor() { this.handlers = new Map(); this.nextId = 0; }
    connect(name, fn) { const id = ++this.nextId; this.handlers.set(id, {name, fn}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const entry of this.handlers.values()) if (entry.name === name) entry.fn(this, ...args);
    }
}
class Actor {
    constructor(props = {}) { Object.assign(this, props); this.children = []; }
    add_child(child) { this.children.push(child); }
    add_style_class_name() {}
    remove_style_class_name() {}
    set_style_class_name(name) { this.style_class = name; }
    static list_properties() { return [{name: 'orientation'}]; }
}
class Label extends Actor {
    constructor(props) { super(props); this.clutter_text = {set_ellipsize() {}, set_line_alignment() {}}; }
    set_text(text) { this.text = text; }
}
class Item extends Signals {
    constructor(text) { super(); this.label = new Label({text}); }
    setSensitive(value) { this.sensitive = value; }
    add_child(child) { (this.children ??= []).push(child); }
    remove_style_class_name() {}
}
class Switch extends Item {
    setToggleState(value) { this.state = value; this.emit('toggled', value); }
}
const registry = new Map();
const buttons = [];
class Button {
    constructor() {
        this.items = [];
        this.menu = {actor: new Actor(), addMenuItem: item => this.items.push(item)};
        this.destroyed = false;
        buttons.push(this);
    }
    add_child(child) { this.child = child; }
    destroy() {
        this.destroyed = true;
        for (const [role, button] of registry) if (button === this) registry.delete(role);
    }
}
const monitors = [];
const timers = new Map();
let nextTimer = 0;
const monitorFile = {monitor_directory() {
    const monitor = new Signals();
    monitor.cancel = () => { monitor.cancelled = true; };
    monitors.push(monitor);
    return monitor;
}};
class Settings extends Signals {
    constructor() { super(); this.show = true; }
    get_boolean() { return this.show; }
    get_string() { return this.language ?? 'system'; }
    set_string(_key, value) { this.language = value; this.emit('changed::ui-language'); }
}
const settings = new Settings();
class ThemeSettings extends Signals {
    constructor() { super(); this.theme = "DockNormalized"; }
    get_string() { return this.theme; }
    set_string(_key, value) { this.theme = value; this.emit("changed::icon-theme"); }
}
const themeSettings = new ThemeSettings();
const requests = [];
const status = {backend_version: '3.1.0', installed: true, automatic: 'on', revision: 'a'.repeat(64),
    overlay_in_use: true, summary: {managed_icons: 25}};
let openedPreferences = 0;
const fakeModules = {
    'gi://GLib': {default: {
        get_home_dir: () => '/fixture', build_filenamev: parts => parts.join('/'),
        get_language_names: () => ['zh_CN', 'C'],
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add: (_priority, _delay, fn) => { timers.set(++nextTimer, fn); return nextTimer; },
        source_remove: id => timers.delete(id),
    }},
    'gi://Gio': {default: {File: {new_for_path: () => monitorFile,
        new_for_uri: () => ({get_parent: () => ({resolve_relative_path: () => ({})})})},
        FileIcon: class {}, FileMonitorFlags: {NONE: 0}, Settings: class {constructor() {return themeSettings;}}}},
    'gi://Clutter': {default: {ActorAlign: {CENTER: 0}, Orientation: {VERTICAL: 1}}},
    'gi://St': {default: {Label, Icon: Actor, BoxLayout: Actor}},
    'gi://Pango': {default: {EllipsizeMode: {END: 3}, Alignment: {RIGHT: 2}}},
    'resource:///org/gnome/shell/ui/main.js': {panel: {addToStatusArea(role, button) {
        if (registry.has(role)) throw new Error('duplicate panel role');
        registry.set(role, button);
    }}},
    'resource:///org/gnome/shell/ui/panelMenu.js': {Button},
    'resource:///org/gnome/shell/ui/popupMenu.js': {
        PopupMenuItem: Item, PopupSwitchMenuItem: Switch, PopupSeparatorMenuItem: Item,
        PopupImageMenuItem: Item, PopupBaseMenuItem: Item,
    },
    'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {
        getSettings() { return settings; }
        openPreferences() { openedPreferences++; }
    }},
};
const clientUrl = new URL('lib/backendClient.js', extensionRoot).href;
let delayedRequest = null;
fakeModules[clientUrl] = {RequestScope: class {constructor() {this.closed = false;} close() {this.closed = true;}}, call: async (_path, operation, arguments_, scope) => {
    if (scope?.closed) return {ok: false, error: {code: 'TIMEOUT'}};
    requests.push({operation, arguments: arguments_});
    if (delayedRequest) {const pending = delayedRequest; delayedRequest = null; return await pending;}
    return {ok: true, result: status};
}};
const context = createContext({logError: err => { throw err; }});
const modules = new Map();
function getModule(id) {
    if (modules.has(id)) return modules.get(id);
    const stub = fakeModules[id];
    const module = stub
        ? new SyntheticModule(Object.keys(stub), function () {
            for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
        }, {context, identifier: id})
        : new SourceTextModule(readFileSync(fileURLToPath(id), 'utf8'), {context, identifier: id});
    modules.set(id, module);
    return module;
}
const entry = getModule(new URL('extension.js', extensionRoot).href);
await entry.link((specifier, parent) => getModule(specifier.startsWith('.')
    ? new URL(specifier, parent.identifier).href : specifier));
await entry.evaluate();
const Extension = entry.namespace.default;
const extension = new Extension();
const drain = () => new Promise(resolve => setImmediate(resolve));
extension.enable();
await drain();
assert.equal(registry.size, 1);
let button = registry.get('icon-normalizer');
assert.ok(!(button.child instanceof Label));
assert.equal(button.child.style_class, 'system-status-icon');
assert.equal(button.items.length, 7);
assert.match(extension._indicator._detailLabel.text, /已开启/);
console.log('ok   enabled entry constructs and registers complete menu');

requests.length = 0;
extension._indicator.update(status, {ok: true});
assert.equal(requests.length, 0);
extension._indicator._autoItem.setToggleState(false);
await drain();
assert.deepEqual(requests.map(r => r.operation), ['automation.set', 'status']);
assert.equal(requests[0].arguments.enabled, false);
console.log('ok   state refresh is silent and user toggle sends one request');

requests.length = 0;
extension._indicator._checkItem.emit('activate');
extension._indicator._settingsItem.emit('activate');
await drain();
assert.deepEqual(requests.map(r => r.operation), ['scan', 'status']);
assert.equal(openedPreferences, 1);
console.log('ok   check and preferences menu actions reach their handlers');

requests.length = 0;
extension._indicator._applyItem.emit('activate');
extension._indicator._applyItem.emit('activate');
await drain();
assert.equal(requests.filter(r => r.operation === 'apply').length, 1);
assert.deepEqual(requests.slice(0, 3).map(r => r.operation), ['status', 'apply', 'status']);
assert.equal(extension._pending.size, 0);
console.log('ok   rapid apply clicks coalesce into one complete apply flow');

requests.length = 0;
settings.set_string('ui-language', 'en');
assert.equal(extension._indicator._nameLabel.text, 'Icon Normalizer');
assert.equal(extension._indicator._checkItem.label.text, 'Check now');
assert.equal(button.accessible_name, 'Icon Normalizer');
assert.equal(requests.length, 0);
settings.set_string('ui-language', 'zh');
assert.equal(extension._indicator._checkItem.label.text, '立即检查');
console.log('ok   language changes relabel the same menu without backend writes');

extension._indicator.update({...status, installed: false}, {ok: true});
assert.equal(extension._indicator._stateLabel.text, '后台未安装');
assert.equal(extension._indicator._applyItem.sensitive, false);
extension._indicator.update({...status, busy: true}, {ok: true});
assert.equal(extension._indicator._checkItem.sensitive, false);
extension._indicator.update({...status, recovery_pending: true}, {ok: true});
assert.equal(extension._indicator._stateLabel.text, '有待恢复事务');
extension._indicator.update(status, {ok: false, error: {code: 'BUSY'}});
assert.match(extension._indicator._detailLabel.text, /稍后重试/);
extension._indicator.update(status, {ok: true});
console.log('ok   missing backend, busy, recovery and failure render distinct states');

const monitor = monitors.at(-1);
monitor.emit('changed');
assert.equal(timers.size, 1);
extension.disable();
assert.equal(registry.size, 0);
assert.equal(timers.size, 0);
assert.equal(monitor.cancelled, true);
assert.equal(monitor.handlers.size, 0);
assert.equal(settings.handlers.size, 0);
assert.equal(themeSettings.handlers.size, 0);
extension.enable();
await drain();
button = registry.get('icon-normalizer');
assert.equal(button.items.length, 7);
extension.disable();
assert.equal(registry.size, 0);
console.log('ok   disable cleans up monitor, timers and role; re-enable works');

const {Indicator} = modules.get(new URL('ui/indicator.js', extensionRoot).href).namespace;
registry.set('icon-normalizer', {});
assert.throws(() => new Indicator({}), /duplicate panel role/);
assert.equal(buttons.at(-1).destroyed, true);
registry.clear();
console.log('ok   failed construction destroys the partially created button');
extension.enable(); await drain(); requests.length = 0;
let release;
delayedRequest = new Promise(resolve => {release = resolve;});
extension._request('status');
extension.disable(); extension.enable(); await drain();
release({ok: true, result: {...status, revision: 'z'.repeat(64)}}); await drain();
assert.equal(extension._lastRevision, status.revision);
console.log('ok   late callbacks from a disabled session cannot update a re-enabled session');
requests.length = 0;
themeSettings.set_string('icon-theme', 'FixtureBlue');
assert.equal(timers.size, 1);
const fire = () => {for (const [id, fn] of [...timers]) {timers.delete(id); fn();}};
let releaseTheme;
delayedRequest = new Promise(resolve => {releaseTheme = resolve;});
fire();
themeSettings.set_string('icon-theme', 'FixtureGreen'); fire();
releaseTheme({ok: true, result: {changed: true}}); await drain();
assert.equal(requests.filter(r => r.operation === 'theme.sync').length, 2);
themeSettings.set_string('icon-theme', 'DockNormalized');
assert.equal(timers.size, 0);
themeSettings.set_string('icon-theme', 'FixtureBlue');
extension.disable();
assert.equal(timers.size, 0); assert.equal(themeSettings.handlers.size, 0);
console.log('ok   theme switches debounce, coalesce the latest choice and clean up on disable');
registry.set('icon-normalizer', {});
assert.throws(() => extension.enable(), /duplicate panel role/);
assert.equal(settings.handlers.size, 0); assert.equal(themeSettings.handlers.size, 0);
assert.equal(timers.size, 0); registry.clear();
console.log('ok   entry failure disconnects settings and theme listeners');
extension.enable(); await drain(); requests.length = 0;
extension._lastStatus = {...status, backend_version: '3.0.2'};
await extension._syncTheme();
assert.equal(requests.filter(r => r.operation === 'theme.sync').length, 0);
assert.equal(extension._pending.size, 0); extension.disable();
console.log('ok   old companion skips unsupported theme operations after ZIP-only upgrade');
console.log('12/12 passed');
