// Production client with a controllable subprocess boundary; no rewritten code.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
const timers = new Map(), children = []; let timer = 0, exists = true;
class Child {
    communicate_utf8_async(payload, _cancel, callback) { this.request = JSON.parse(payload); this.callback = callback; }
    communicate_utf8_finish() { this.reaped = true; return [true, this.output, '']; }
    get_if_exited() { return !this.signaled; }
    get_exit_status() { assert.ok(!this.signaled); return this.exit ?? 0; }
    force_exit() { this.killed = true; if (this.alreadyExited) throw new Error('already exited'); }
    finish(envelope = {ok: true, result: {}}) {
        this.output = typeof envelope === 'string' ? envelope : JSON.stringify({...this.request, ...envelope});
        this.callback(this, {});
    }
}
const stubs = {
 'gi://GLib': {default: {uuid_string_random: () => 'fixture', PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
   timeout_add: (_p, _ms, fn) => {timers.set(++timer, fn); return timer;}, source_remove: id => timers.delete(id)}},
 'gi://Gio': {default: {File: {new_for_path: () => ({query_exists: () => exists})},
   SubprocessFlags: {STDIN_PIPE: 1, STDOUT_PIPE: 2, STDERR_PIPE: 4},
   SubprocessLauncher: class {spawnv(argv) {assert.deepEqual(Array.from(argv), ['/usr/bin/python3', '/control.py', '--json']);
      const child = new Child(); children.push(child); return child;}}}},
};
const context = createContext({logError: () => {}}), modules = new Map();
function module(id) {
 if (modules.has(id)) return modules.get(id);
 const values = stubs[id];
 const m = values ? new SyntheticModule(Object.keys(values), function () {
   for (const [k,v] of Object.entries(values)) this.setExport(k,v);
 }, {context, identifier: id}) : new SourceTextModule(readFileSync(fileURLToPath(id), 'utf8'), {context, identifier: id});
 modules.set(id,m); return m;
}
const entry = module(new URL('../../extension/lib/backendClient.js', import.meta.url).href);
await entry.link((s,p) => module(s.startsWith('.') ? new URL(s,p.identifier).href : s)); await entry.evaluate();
const {call, RequestScope} = entry.namespace;
let promise = call('/control.py', 'status', {}); children.at(-1).finish();
assert.equal((await promise).ok, true); assert.equal(timers.size,0);
console.log('ok   successful response validates identity and removes its timer');
const readScope = new RequestScope(); promise = call('/control.py', 'status', {}, readScope);
const read = children.at(-1); read.alreadyExited = true; readScope.close();
assert.equal((await promise).error.code,'TIMEOUT'); assert.equal(timers.size,0);
read.finish(); assert.ok(read.killed && read.reaped);
console.log('ok   closing reads tolerates exit races, removes timers and reaps children');
const writeScope = new RequestScope(); promise = call('/control.py', 'apply', {}, writeScope);
const writer = children.at(-1); writeScope.close(); await promise;
assert.ok(!writer.killed); assert.equal(timers.size,0); writer.finish(); assert.ok(writer.reaped);
console.log('ok   closing never kills a writer, while late completion is reaped');
const count = children.length; assert.equal((await call('/control.py','apply',{},writeScope)).ok,false);
assert.equal(count, children.length);
console.log('ok   a closed scope cannot spawn another apply step');
exists = false; assert.equal((await call('/control.py','status',{})).error.code,'NOT_INSTALLED');
assert.equal(count,children.length); exists = true;
console.log('ok   missing companion gives a useful installation error without spawning');
promise = call('/control.py','apply',{}); const timedWriter = children.at(-1);
for (const [id,fn] of [...timers]) {timers.delete(id); fn();}
assert.equal((await promise).error.details.timed_out,true); assert.ok(!timedWriter.killed);
timedWriter.finish();
console.log('ok   writer timeout reports unconfirmed work and leaves the process alive');
for (const [envelope,code] of [[{ok:true,result:[]},'IO_ERROR'], [{ok:'yes',result:{}},'IO_ERROR'],
 [{ok:false,error:{}},'IO_ERROR'], ['bad json','IO_ERROR'], [{api_version:2,ok:true,result:{}},'INTERNAL_ERROR']]) {
 promise=call('/control.py','status',{}); children.at(-1).finish(envelope);
 assert.equal((await promise).error.code,code); assert.equal(timers.size,0);
}
console.log('ok   malformed envelopes, result arrays and identity mismatches are rejected');
promise=call('/control.py','status',{}); const mismatch=children.at(-1); mismatch.exit=1; mismatch.finish();
assert.equal((await promise).error.code,'IO_ERROR');
console.log('ok   success response with failure exit status is rejected');
promise=call('/control.py','status',{}); const signaled=children.at(-1); signaled.signaled=true; signaled.finish();
assert.equal((await promise).error.code,'IO_ERROR');
console.log('ok   signaled children never access get_exit_status');
const scope=new RequestScope(); promise=call('/control.py','status',{},scope); children.at(-1).finish(); await promise;
assert.equal(scope._requests.size,0); scope.close(); assert.equal(timers.size,0);
console.log('ok   completed calls detach from scope');
console.log('10/10 passed');
