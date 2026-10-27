// SPDX-License-Identifier: GPL-3.0-or-later
// Async JSON CLI client. Promises NEVER reject — every failure resolves an
// error envelope so callers can render it uniformly.
//
// Writer operations are never force-killed on timeout: the backend finishes on
// its own and the UI shows an "unconfirmed" hint (PROTOCOL.md §8).
import {t} from './i18n.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const API_VERSION = 1;

// Read-style timeouts per operation (writers use the long tail and are not killed).
const TIMEOUT_MS = {
    status: 5000,
    doctor: 5000,
    preview: 15000,
    scan: 120000,
    configure: 125000,
    'rules.set': 125000,
    apply: 125000,
    'automation.set': 30000,
    revert: 130000,
    'profiles.list': 5000,
    'profiles.save': 10000,
    'profiles.delete': 10000,
    'theme.follow': 10000,
    'theme.sync': 125000,
};

const READ_ONLY = new Set(['status', 'doctor', 'scan', 'preview', 'profiles.list']);

export class RequestScope {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._requests = new Set();
        this._cleanups = new Set();
    }

    get closed() { return this._cancellable.is_cancelled(); }
    add(cancel) { this._requests.add(cancel); }
    remove(cancel) { this._requests.delete(cancel); }

    cleanup(callback) {
        if (this.closed) callback();
        else this._cleanups.add(callback);
        return () => this._cleanups.delete(callback);
    }

    delay(milliseconds) {
        if (this.closed) return Promise.resolve(false);
        return new Promise(resolve => {
            const cancel = () => { GLib.source_remove(id); resolve(false); };
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                this._cleanups.delete(cancel);
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
            this._cleanups.add(cancel);
        });
    }

    async read(controlPath, operation, args = {}) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const result = await call(controlPath, operation, args, this);
            if (this.closed || result.ok || result.error?.code !== 'BUSY' || attempt === 3)
                return result;
            if (!await this.delay(250)) return result;
        }
    }

    close() {
        this._cancellable.cancel();
        for (const cancel of [...this._requests]) cancel();
        this._requests.clear();
        for (const cleanup of this._cleanups) cleanup();
        this._cleanups.clear();
    }
}

export function controlArgv(controlPath) {
    // Fixed argv; the request itself never carries executable paths.
    return ['/usr/bin/python3', controlPath, '--json'];
}

function fail(requestId, operation, code, message, retryable = false, timedOut = false) {
    return {
        api_version: API_VERSION,
        request_id: requestId,
        operation,
        ok: false,
        error: {
            code,
            message,
            retryable: !!retryable,
            details: timedOut ? {timed_out: true} : {},
        },
    };
}

/**
 * Run one protocol request against the backend control CLI.
 *
 * @param {string} controlPath absolute path of the installed control.py
 * @param {string} operation one of PROTOCOL.md §3 operations
 * @param {object} args operation arguments (validated server-side)
 * @returns {Promise<object>} a response envelope (never rejects)
 */
export function call(controlPath, operation, args, scope = null) {
    return new Promise(resolve => {
        const requestId = `ui-${GLib.uuid_string_random()}`;
        if (scope?.closed) {
            resolve(fail(requestId, operation, 'TIMEOUT', t('窗口已关闭')));
            return;
        }
        if (!Gio.File.new_for_path(controlPath).query_exists(null)) {
            resolve(fail(requestId, operation, 'NOT_INSTALLED', t('后台尚未安装，请安装配套服务。')));
            return;
        }
        const payload = JSON.stringify({
            api_version: API_VERSION,
            request_id: requestId,
            operation,
            arguments: args || {},
        });

        let launcher;
        let sub;
        try {
            launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            sub = launcher.spawnv(controlArgv(controlPath));
        } catch (err) {
            logError(err, 'icon-normalizer: spawn failed');
            resolve(fail(requestId, operation, 'SPAWN_FAILED', String(err)));
            return;
        }

        let done = false;
        let timeoutId = 0;
        const cancel = () => {
            if (READ_ONLY.has(operation)) {
                try { sub.force_exit(); } catch (_) { /* It may already have exited. */ }
            }
            // Writers keep running and are reaped by communicate_finish below.
            settle(fail(requestId, operation, 'TIMEOUT', t('窗口已关闭')));
        };
        const settle = envelope => {
            if (done) return;
            done = true;
            if (timeoutId) GLib.source_remove(timeoutId);
            timeoutId = 0;
            scope?.remove(cancel);
            resolve(envelope);
        };
        scope?.add(cancel);

        const timeoutMs = TIMEOUT_MS[operation] ?? 30000;
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = 0;
            if (READ_ONLY.has(operation)) {
                // Read-style cancellation only; writers are never force-killed.
                try {
                    sub.force_exit();
                } catch (err) {
                    logError(err, 'icon-normalizer: force_exit failed');
                }
            }
            settle(fail(requestId, operation, 'TIMEOUT',
                `${operation} timed out after ${timeoutMs} ms`,
                READ_ONLY.has(operation), true));
            return GLib.SOURCE_REMOVE;
        });

        sub.communicate_utf8_async(payload, null, (proc, result) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                if (done) return;
                let envelope;
                try {
                    envelope = JSON.parse(stdout);
                } catch (parseErr) {
                    logError(parseErr, 'icon-normalizer: invalid backend output');
                    settle(fail(requestId, operation, 'IO_ERROR',
                        `invalid backend output: ${(stdout || stderr || '').slice(0, 120)}`));
                    return;
                }
                if (envelope.request_id !== requestId ||
                    envelope.api_version !== API_VERSION ||
                    envelope.operation !== operation) {
                    logError(new Error('identity mismatch'),
                        `icon-normalizer: response identity mismatch for ${operation}`);
                    settle(fail(requestId, operation, 'INTERNAL_ERROR', t('响应身份或版本不匹配')));
                    return;
                }
                if (typeof envelope.ok !== 'boolean' ||
                    (envelope.ok && (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result))) ||
                    (!envelope.ok && (!envelope.error || typeof envelope.error.code !== 'string')) ||
                    !proc.get_if_exited() ||
                    (envelope.ok !== (proc.get_exit_status() === 0))) {
                    settle(fail(requestId, operation, 'IO_ERROR', t('后台响应格式或退出状态无效')));
                    return;
                }
                settle(envelope);
            } catch (err) {
                if (done) return;
                logError(err, `icon-normalizer: ${operation} communication failed`);
                settle(fail(requestId, operation, 'IO_ERROR', String(err)));
            }
        });
    });
}
