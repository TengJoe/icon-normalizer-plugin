// Transactional file application with a recovery journal.
// Port of backend/icon_normalizer/core/transaction.py.
//
// Change-sets are applied only under the caller-held sync lock. Every write is
// preceded by an expected-digest guard, so a file another writer touched since
// inspection aborts the whole set instead of being silently overwritten. The
// journal records the previous bytes so an interrupted run can be rolled back.
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
 * True when a path is the root itself or lives inside it.
 *
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
export function underRoot(path, root) {
    return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
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
     * @returns {boolean}
     */
    recover() {
        const bytes = readBytes(this.journalPath);
        if (!bytes) return false;
        const journal = JSON.parse(new TextDecoder().decode(bytes));
        const ops = journal.ops || [];
        for (let i = ops.length - 1; i >= 0; i--) {
            const op = ops[i];
            if (op.before === null || op.before === undefined) {
                durableUnlink(op.path);
            } else {
                const decoded = GLib.base64_decode(op.before);
                if (shaHex(readBytes(op.path)) !== op.before_sha)
                    atomicWrite(op.path, decoded, this.modeFor(op.path));
            }
        }
        durableUnlink(this.journalPath);
        return true;
    }
}
