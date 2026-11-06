// Transactional file application with a recovery journal.
// Port of backend/icon_normalizer/core/transaction.py.
//
// Change-sets are applied only under the caller-held sync lock (see SyncLock
// below; it flocks the same state-dir lock file the Python worker uses). Every
// write is preceded by an expected-digest guard, so a file another writer
// touched since inspection aborts the whole set instead of being silently
// overwritten. The journal records the previous bytes so an interrupted run can
// be rolled back without clobbering external edits.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Hex SHA-256 of a byte array or string, or null for a missing file.
 *
 * @param {Uint8Array|string|null|undefined} data
 * @returns {string|null}
 */
export function shaHex(data) {
    if (data === null || data === undefined) return null;
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    checksum.update(bytes);
    return checksum.get_string();
}

/**
 * Read a file, returning null when it does not exist.
 *
 * @param {string} path
 * @returns {Uint8Array|null}
 */
export function readBytes(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) return null;
    const [, bytes] = file.load_contents(null);
    return bytes;
}

/**
 * Write a file atomically: a full replacement through a temporary file.
 *
 * @param {string} path
 * @param {Uint8Array} data
 * @param {number} mode octal file mode
 */
export function atomicWrite(path, data, mode = 0o644) {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null))
        parent.make_directory_with_parents(null);
    file.replace_contents(data, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    try {
        GLib.chmod(path, mode);
    } catch {
        // Modes are best-effort on exotic filesystems.
    }
}

/**
 * Delete a file when present.
 *
 * @param {string} path
 */
export function durableUnlink(path) {
    const file = Gio.File.new_for_path(path);
    if (file.query_exists(null)) file.delete(null);
}

export class TransactionError extends Error {
    constructor(message) {
        super(message);
        this.name = "TransactionError";
    }
}

/**
 * Lexically resolve "." and ".." segments of an absolute path. Gio never
 * resolves symlinks here, but a path like ".../DockNormalized/../x" must not
 * pass a plain prefix check, so every root test goes through this first.
 *
 * @param {string} path absolute path
 * @returns {string} normalized path
 */
export function normalizePath(path) {
    if (!path.startsWith("/")) return path;
    const out = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (out.length) out.pop();
            continue;
        }
        out.push(part);
    }
    return "/" + out.join("/");
}

/**
 * True when a path is the root itself or lives inside it. Both sides are
 * lexically normalized so ".." segments cannot escape a root prefix check.
 *
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
export function underRoot(path, root) {
    const p = normalizePath(path);
    const r = normalizePath(root);
    return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
}

/** Failed lock acquisition, surfaced as a retryable BUSY to the UI. */
export class LockError extends Error {
    constructor(message) {
        super(message);
        this.name = "LockError";
        this.code = "BUSY";
        this.retryable = true;
        this.details = {};
    }
}

/**
 * Advisory single-writer lock, shared with the Python worker by holding an
 * exclusive flock on the same state-dir lock file (backend control.py §locking).
 *
 * The lock is held by a small ``flock`` holder process whose stdin stays open;
 * when this process dies the pipe closes, the holder exits and the kernel
 * releases the lock — no stale-lock arbitration is needed. When ``flock`` is
 * unavailable an O_EXCL lock file with a generous mtime-based staleness check
 * is used instead (never race-safe against the Python worker, but safe between
 * Shell and Prefs, which are both GJS).
 */
export class SyncLock {
    /** mtime age after which a fallback lock file is treated as crash debris. */
    static STALE_SECONDS = 1800;

    /**
     * @param {string} lockPath state-dir sync.lock location
     */
    constructor(lockPath) {
        this.lockPath = lockPath;
        this._proc = null;
        this._fallbackPath = null;
    }

    /**
     * Acquire the lock or throw LockError. Blocking is bounded: ``flock -n``
     * returns immediately either way.
     */
    acquire() {
        const flock = GLib.find_program_in_path("flock");
        if (flock) this.#acquireFlock(flock);
        else this.#acquireLockFile();
    }

    #acquireFlock(flock) {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE,
            });
            proc = launcher.spawnv([flock, "-x", "-n", this.lockPath,
                "/bin/sh", "-c", "echo LOCKED; exec cat >/dev/null"]);
        } catch (error) {
            throw new LockError("sync lock unavailable: " + error);
        }
        // The holder prints LOCKED once the lock is ours, then blocks on stdin.
        // A failed flock exits instantly, closing the pipe (read_line → null).
        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const cancellable = new Gio.Cancellable();
        const guard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000,
            () => { cancellable.cancel(); return GLib.SOURCE_REMOVE; });
        let line = null;
        try {
            [line] = stdout.read_line(cancellable);
        } catch {
            line = null;
        } finally {
            if (guard) GLib.source_remove(guard);
        }
        if (line === null || new TextDecoder().decode(line).trim() !== "LOCKED") {
            try { proc.force_exit(); } catch { /* already gone */ }
            throw new LockError("another writer holds " + this.lockPath);
        }
        this._proc = proc;
    }

    #acquireLockFile() {
        const file = Gio.File.new_for_path(this.lockPath);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                file.create(Gio.FileCreateFlags.NONE, null); // O_EXCL semantics
                this._fallbackPath = this.lockPath;
                return;
            } catch {
                const info = file.query_info(
                    Gio.FILE_ATTRIBUTE_TIME_MODIFIED, Gio.FileQueryInfoFlags.NONE, null);
                const age = info ? Date.now() / 1000
                    - info.get_modification_date_time().to_unix() : 0;
                if (age < SyncLock.STALE_SECONDS || attempt === 1)
                    throw new LockError("another writer holds " + this.lockPath);
                file.delete(null); // stale crash debris
            }
        }
    }

    /** Release the lock. Safe to call more than once. */
    release() {
        if (this._proc) {
            // Close the holder's stdin: cat sees EOF, exits, flock unlocks.
            try { this._proc.get_stdin_pipe()?.close(null); } catch { /* gone */ }
            try { this._proc.wait(null); } catch { /* already gone */ }
            this._proc = null;
        }
        if (this._fallbackPath) {
            try { Gio.File.new_for_path(this._fallbackPath).delete(null); }
            catch { /* another holder owns it now */ }
            this._fallbackPath = null;
        }
    }
}

export class TransactionStore {
    /**
     * @param {string} journalPath recovery journal location
     * @param {{path: string, fileMode: number}[]} roots writable trees
     * @param {(changedTheme: boolean) => void} [finalize] hook run after writes
     */
    constructor(journalPath, roots, finalize = null) {
        this.journalPath = journalPath;
        this.roots = roots.map(root => ({path: root.path, fileMode: root.fileMode}));
        this.finalize = finalize;
    }

    /**
     * Reject paths outside every protected root.
     *
     * @param {string} path
     * @returns {string} the same path
     */
    allowed(path) {
        for (const root of this.roots)
            if (underRoot(path, root.path)) return path;
        throw new Error("Unmanaged output path: " + path);
    }

    /**
     * @param {string} path
     * @returns {number} octal mode enforced for this tree
     */
    modeFor(path) {
        for (const root of this.roots)
            if (underRoot(path, root.path)) return root.fileMode;
        return 0o644;
    }

    /**
     * Verify that every guarded path still holds the expected digest.
     *
     * @param {Map<string, string|null>} guards
     */
    verifyExpected(guards) {
        const conflicts = [];
        for (const [path, digest] of guards) {
            this.allowed(path);
            if (shaHex(readBytes(path)) !== digest) conflicts.push(path);
        }
        if (conflicts.length)
            throw new TransactionError("changed_since_inspection: " + conflicts.join(", "));
    }

    /**
     * Apply a change-set; the manifest-like payload commits last.
     *
     * @param {Map<string, Uint8Array|null>} changes path -> bytes, or null to delete
     * @param {{committedLast?: [string, Uint8Array], expectedBefore?: Map<string, string|null>}} options
     * @returns {{operations: number, changedTheme: boolean}}
     */
    commit(changes, options = {}) {
        const guards = new Map(options.expectedBefore || []);
        for (const key of guards.keys()) this.allowed(key);
        this.verifyExpected(guards);

        const all = new Map(changes);
        if (options.committedLast) all.set(options.committedLast[0], options.committedLast[1]);

        const ops = [];
        const payloads = [];
        const themeRoot = this.roots.length ? this.roots[0].path : null;
        for (const [path, data] of all) {
            this.allowed(path);
            const before = readBytes(path);
            if (!guards.has(path)) guards.set(path, shaHex(before));
            const same = (before === null && data === null)
                || (before !== null && data !== null && shaHex(before) === shaHex(data));
            if (same) continue;
            ops.push({path, before, beforeSha: shaHex(before), afterSha: shaHex(data)});
            payloads.push(data);
        }

        this.verifyExpected(guards);
        if (ops.length) {
            const journal = {ops: ops.map(op => ({
                path: op.path,
                before: op.before ? GLib.base64_encode(op.before) : null,
                before_sha: op.beforeSha,
                after_sha: op.afterSha,
            }))};
            atomicWrite(this.journalPath, new TextEncoder().encode(JSON.stringify(journal)), 0o600);
        }

        const attempted = [];
        let changedTheme = false;
        try {
            this.verifyExpected(guards);
            ops.forEach((op, index) => {
                const data = payloads[index];
                this.verifyExpected(new Map([[op.path, guards.get(op.path)]]));
                attempted.push(op);
                if (data === null) durableUnlink(op.path);
                else atomicWrite(op.path, data, this.modeFor(op.path));
                if (themeRoot !== null && underRoot(op.path, themeRoot)) changedTheme = true;
                guards.set(op.path, shaHex(data));
            });
            this.verifyExpected(guards);
            if (this.finalize) this.finalize(changedTheme);
            this.verifyExpected(guards);
            if (ops.length) durableUnlink(this.journalPath);
        } catch (error) {
            if (ops.length) {
                if (attempted.length) {
                    const journal = {ops: attempted.map(op => ({
                        path: op.path,
                        before: op.before ? GLib.base64_encode(op.before) : null,
                        before_sha: op.beforeSha,
                        after_sha: op.afterSha,
                    }))};
                    atomicWrite(this.journalPath,
                        new TextEncoder().encode(JSON.stringify(journal)), 0o600);
                    this.recover();
                } else {
                    durableUnlink(this.journalPath);
                }
            }
            throw error;
        }
        return {operations: ops.length, changedTheme};
    }

    /**
     * Replay the journal in reverse; true when a transaction was repaired.
     *
     * PROTOCOL.md §5: an op is only replayed when the disk still holds a state
     * this transaction produced (before or after). Anything else is an external
     * edit made after the crash — it must survive recovery untouched.
     *
     * @returns {boolean}
     */
    recover() {
        const bytes = readBytes(this.journalPath);
        if (!bytes) return false;
        const journal = JSON.parse(new TextDecoder().decode(bytes));
        const ops = journal.ops || [];
        for (let i = ops.length - 1; i >= 0; i--) {
            const op = ops[i];
            this.allowed(op.path);
            const current = readBytes(op.path);
            if (op.before === null || op.before === undefined) {
                // Created by the interrupted transaction: remove only when the
                // file still holds that transaction's bytes.
                if (current === null || shaHex(current) === op.after_sha)
                    durableUnlink(op.path);
            } else {
                if (current === null) continue; // already gone, nothing to restore
                const now = shaHex(current);
                if (now === op.before_sha) continue; // write never happened
                if (now !== op.after_sha) continue; // external edit: refuse
                atomicWrite(op.path, GLib.base64_decode(op.before),
                    this.modeFor(op.path));
            }
        }
        durableUnlink(this.journalPath);
        return true;
    }
}
