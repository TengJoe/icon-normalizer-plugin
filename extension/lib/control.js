// In-process control surface: the same operations the Python control.py served,
// dispatched locally so the extension no longer needs a companion program.
//
// Writers and scan/preview run under the same advisory flock as the Python
// worker (SyncLock), so the Shell process, the prefs process and the systemd
// worker serialize on ~/.local/state/icon-normalizer/sync.lock.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Engine} from './engine/engine.js';
import {loadPixbuf} from './engine/load.js';
import {analyze, plan, CLASSES} from './engine/analyze.js';
import {normalize} from './engine/render.js';
import {classifySourceEx, lookupRuleEx, describeRule} from './engine/classification.js';
import {SyncLock, readBytes, shaHex, atomicWrite} from './engine/transaction.js';
import {applyPatch, ProfilesStore, ThemeFollowStore} from './stores.js';
import {XdgIconResolver} from './engine/resolver.js';

/** Default policy when the state directory has none yet. */
export const DEFAULT_POLICY = {
    base_theme: 'Yaru',
    target: 0.83,
    deadband: 0.02,
    inner: 0.7,
    sizes: [16, 24, 32, 48, 64, 96, 128, 256, 512],
};

const SIZES = DEFAULT_POLICY.sizes;

/** Error carrying a PROTOCOL.md §6 code; backendClient surfaces it verbatim. */
export class ControlError extends Error {
    /**
     * @param {string} code machine-readable protocol error code
     * @param {string} message human-readable explanation
     * @param {{retryable?: boolean, details?: object}} [options]
     */
    constructor(code, message, {retryable = false, details = {}} = {}) {
        super(message);
        this.name = 'ControlError';
        this.code = code;
        this.retryable = retryable;
        this.details = details;
    }
}

/** Read JSON, or null. */
function readJson(path) {
    const bytes = readBytes(path);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

/** Write JSON with the given mode. */
function writeJson(path, value, mode = 0o600) {
    atomicWrite(path, new TextEncoder().encode(JSON.stringify(value, null, 2)), mode);
}

export function rowsToGroups(rows, rules) {
    return rows.map(row => {
        const iconName = String(row.icon_name || '');
        const iconId = shaHex(iconName);
        const rule = rules[iconId] || rules[iconName];
        const skipped = Boolean(rule && rule.skip);
        let cls = row.class;
        const autoClass = row.auto_class || cls;
        let stale = false;
        if (rule && !rule.skip && rule.classification && rule.classification !== 'auto') {
            if (rule.source_sha256 && rule.source_sha256 !== row.source_sha256) {
                stale = true;
                cls = autoClass;
            }
        }
        let action = row.action;
        let reason = row.reason;
        if (skipped) {
            action = 'skipped';
            reason = 'user_skip';
        }
        if (!row.source_path && action !== 'excluded') {
            action = 'unresolved';
            reason = row.reason || 'source_unavailable';
        }
        const manualUser = Boolean(rule && !stale && rule.classification && rule.classification !== 'auto');
        const origin = manualUser ? 'user'
            : (row.classification_confidence === 'reviewed' ? 'reviewed' : 'automatic');
        return {
            icon_id: iconId,
            icon_name: iconName,
            names: row.names || [],
            desktop_ids: row.desktop_ids || [],
            source_path: row.source_path || null,
            source_sha256: row.source_sha256 || null,
            source_ratio: row.source_ratio ?? null,
            classification: cls || null,
            classification_origin: origin,
            classification_stale: stale,
            suggested_class: row.suggested_class || null,
            action,
            reason,
            skipped,
        };
    });
}

export class LocalControl {
    /**
     * @param {{settings: object, home?: string, resolver?: object,
     *          locking?: boolean, slicing?: boolean}} options
     *
     * `locking` serializes engine operations through the state-dir sync.lock
     * (enable it in processes with a live main loop: gnome-shell and prefs).
     * `slicing` runs the engine phases across idle callbacks instead of one
     * synchronous block. Unit tests leave both off.
     */
    constructor(options) {
        this.settings = options.settings;
        this.home = options.home || GLib.get_home_dir();
        this.resolver = options.resolver || null;
        this.locking = Boolean(options.locking);
        this.slicing = Boolean(options.slicing);
        this._lock = null;
        this.stateDir = GLib.build_filenamev([this.home, '.local', 'state', 'icon-normalizer']);
        this.themeDir = GLib.build_filenamev([this.home, '.local', 'share', 'icons',
            'DockNormalized']);
        const userAppsEnv = GLib.getenv('ICON_NORMALIZER_USER_APPS');
        this.appsDir = userAppsEnv || GLib.build_filenamev([this.home, '.local', 'share', 'applications']);
        GLib.mkdir_with_parents(this.stateDir, 0o755);
    }

    /** @returns {string} shared lock file, matching the Python worker */
    lockPath() {
        return GLib.build_filenamev([this.stateDir, 'sync.lock']);
    }

    /** @returns {string} path of the pending recovery journal */
    pendingPath() {
        return GLib.build_filenamev([this.stateDir, 'pending.json']);
    }

    /**
     * Run fn under the single-writer lock when locking is enabled.
     *
     * @param {Function} fn synchronous or async engine work
     * @returns {Promise<object>} fn's result
     */
    async #locked(fn) {
        if (!this.locking) return fn();
        const lock = new SyncLock(this.lockPath());
        lock.acquire(); // throws LockError (code BUSY) when another writer holds it
        try {
            return await fn();
        } finally {
            lock.release();
        }
    }

    /** @returns {object} policy from config.json, merged over the defaults */
    policy() {
        const stored = readJson(GLib.build_filenamev([this.stateDir, 'config.json']));
        const raw = (stored && stored.policy) || stored || {};
        return {
            base_theme: raw.base_theme || (this.settings && this.settings.baseTheme())
                || DEFAULT_POLICY.base_theme,
            target: Number(raw.target ?? DEFAULT_POLICY.target),
            deadband: Number(raw.deadband ?? DEFAULT_POLICY.deadband),
            inner: Number(raw.inner ?? DEFAULT_POLICY.inner),
            sizes: raw.sizes || SIZES,
        };
    }

    /** @returns {Record<string, object>} reviewed overrides */
    overrides() {
        const doc = readJson(GLib.build_filenamev([this.stateDir, 'overrides.json']));
        if (!doc) return {};
        return doc.icons || doc;
    }

    /** @returns {Record<string, object>} machine-local user rules */
    userRules() {
        const doc = readJson(GLib.build_filenamev([this.stateDir, 'user-rules.json']));
        if (!doc) return {};
        return doc.icons || doc;
    }

    /** @returns {Engine} */
    engine() {
        // An empty override must fall back to the XDG roots, not replace them
        // with an empty list.
        const extraDirs = (GLib.getenv('ICON_NORMALIZER_APPLICATION_DIRS') || '')
            .split(':').filter(Boolean);
        return new Engine({
            home: this.home,
            themeDir: this.themeDir,
            themeName: 'DockNormalized',
            stateDir: this.stateDir,
            userApplications: this.appsDir,
            applicationDirs: extraDirs.length ? extraDirs : undefined,
            desktop: (this.settings && this.settings.desktop()) || 'GNOME',
            policy: this.policy(),
            overrides: this.overrides(),
            userRules: this.userRules(),
            resolver: this.resolver || new XdgIconResolver(this.policy().base_theme, this.home),
            settings: this.settings,
            onHealthEvent: event => this.recordHealth(event),
        });
    }

    /** Append a health event, mirroring backend health.record_event(). */
    recordHealth(event) {
        if (!event) return;
        const path = GLib.build_filenamev([this.stateDir, 'health-events.json']);
        const doc = readJson(path) || {history: []};
        const history = Array.isArray(doc) ? doc : (doc.history || []);
        history.push({...event, at_unix: Date.now() / 1000});
        const trimmed = history.slice(-50);
        writeJson(path, {history: trimmed}, 0o600);
    }

    /** @returns {string} revision over policy and rules */
    revision() {
        return shaHex(JSON.stringify(this.policy()) + JSON.stringify(this.userRules()));
    }

    /** @returns {object} status payload */
    status() {
        const lastRun = readJson(GLib.build_filenamev([this.stateDir, 'last-run.json'])) || {};
        const manifest = readJson(GLib.build_filenamev([this.stateDir, 'manifest.json'])) || {};
        const rules = this.userRules();
        const states = {active: 0, stale_source: 0, unbound: 0, invalid: 0, none: 0};
        for (const [icon, item] of Object.entries(manifest.items || {})) {
            const digest = item.source_sha256;
            // A manifest item is only compared against its own rule, not the
            // first arbitrary entry of the rule table.
            const rule = rules[shaHex(icon)] || rules[icon];
            if (!rule) { states.none++; continue; }
            const bound = rule.source_sha256;
            if (!bound) { states.active++; continue; }
            if (!digest) states.unbound++;
            else if (bound === digest) states.active++;
            else states.stale_source++;
        }
        const activeTheme = this.settings ? this.settings.iconTheme() : null;
        return {
            backend_version: 'gjs-1',
            api_version: 1,
            installed: true,
            revision: this.revision(),
            // In-process operations are synchronous: while one runs, no status
            // can be served at all. Cross-process contention surfaces as a
            // retryable BUSY envelope instead of this flag.
            busy: false,
            stale: false,
            last_apply_at: lastRun.last_updated_at_unix
                ? new Date(lastRun.last_updated_at_unix * 1000).toISOString() : null,
            last_check_at: lastRun.checked_at_unix
                ? new Date(lastRun.checked_at_unix * 1000).toISOString() : null,
            last_scan_at: lastRun.checked_at_unix
                ? new Date(lastRun.checked_at_unix * 1000).toISOString() : null,
            last_error: null,
            recovery_pending: readBytes(this.pendingPath()) !== null,
            summary: lastRun.summary || null,
            automatic: this.unitsStatus().automatic,
            // A failed pass is a real fault the maintenance page must show.
            automatic_error: this.maintenanceError(),
            units: this.unitsStatus(),
            theme_follow: this.themeFollowStore.enabled(),
            source_theme: this.policy().base_theme,
            active_theme: activeTheme,
            overlay_in_use: activeTheme === 'DockNormalized',
            rules_health: {states, warnings: (lastRun.rule_warnings || 0)},
            rule_warnings: lastRun.rule_warnings || 0,
        };
    }

    /**
     * Reject when an interrupted transaction has not been recovered yet.
     * Protocol §5: scan never runs over a pending journal.
     */
    #requireNoPendingJournal() {
        if (readBytes(this.pendingPath()) !== null)
            throw new ControlError('RECOVERY_REQUIRED',
                '存在未完成事务；请先执行一次“立即应用”以恢复',
                {retryable: false, details: {}});
    }

    /** @returns {Promise<object>} scan payload */
    async scan() {
        this.#requireNoPendingJournal();
        return this.#locked(async () => {
            const engine = this.engine();
            const payload = this.slicing
                ? await engine.syncAsync({apply: false}) : engine.sync({apply: false});
            const rules = this.userRules();
            const groups = rowsToGroups(payload.apps, rules);
            const out = {
                revision: this.revision(),
                checked_at_unix: Date.now() / 1000,
                checked_at: new Date().toISOString(),
                summary: payload.summary,
                groups,
            };
            writeJson(GLib.build_filenamev([this.stateDir, 'last-scan.json']), out, 0o600);
            return out;
        });
    }

    /**
     * Apply the current policy, optionally switching the active icon theme.
     *
     * @param {{expected_revision?: string, activate?: boolean}} [args]
     * @returns {Promise<object>} apply payload
     */
    async apply(args = {}) {
        return this.#locked(async () => {
            this.#requireRevision(args);
            const engine = this.engine();
            const payload = this.slicing
                ? await engine.syncAsync({apply: true}) : engine.sync({apply: true});
            payload.theme_activation = this.#activateTheme(Boolean(args.activate));
            return {...payload, revision: this.revision()};
        });
    }

    /**
     * Switch the active icon theme after a committed transaction.
     *
     * @param {boolean} activate
     * @returns {string} 'not_requested' | 'applied' | 'unavailable' | 'superseded'
     */
    #activateTheme(activate) {
        if (!activate) return 'not_requested';
        if (!this.settings || typeof this.settings.setTheme !== 'function')
            return 'unavailable';
        try {
            this.settings.setTheme('DockNormalized');
        } catch {
            return 'unavailable';
        }
        return this.settings.iconTheme() === 'DockNormalized' ? 'applied' : 'superseded';
    }

    /** Reject a stale revision so concurrent writers cannot clobber each other. */
    #requireRevision(args) {
        if (args.expected_revision === undefined || args.expected_revision === null) return;
        if (args.expected_revision === this.revision()) return;
        throw new ControlError('REVISION_CONFLICT', '策略已被其他上下文修改；请刷新后重试',
            {retryable: true, details: {current_revision: this.revision()}});
    }

    /**
     * Render a preview of one icon, mirroring backend preview.preview().
     *
     * @param {{icon_id?: string, source_path?: string, source_sha256?: string,
     *          size?: number, draft?: object}} args protocol arguments
     * @returns {Promise<object>}
     */
    async preview(args) {
        return this.#locked(() => this.#preview(args));
    }

    #preview(args) {
        const size = Math.max(16, Math.min(512, Number(args.size) || 48));
        const draft = args.draft || {};
        const policy = this.policy();
        const target = Number.isFinite(Number(draft.target))
            ? Number(draft.target) : policy.target;
        const deadband = Number.isFinite(Number(draft.deadband))
            ? Number(draft.deadband) : policy.deadband;
        const inner = Number.isFinite(Number(draft.inner)) ? Number(draft.inner) : policy.inner;

        // Identity comes from the last valid scan; arbitrary paths are accepted
        // only when explicitly provided (dev/tests), matching the Python guard.
        const scan = readJson(GLib.build_filenamev([this.stateDir, 'last-scan.json']));
        const iconId = String(args.icon_id || '');
        const group = (scan && Array.isArray(scan.groups))
            ? scan.groups.find(candidate => candidate.icon_id === iconId) || null : null;
        let sourcePath = args.source_path ? String(args.source_path) : null;
        let iconName = group ? String(group.icon_name || '') : (sourcePath || iconId);
        if (!sourcePath) {
            if (!group)
                throw new ControlError('NOT_FOUND', '图标组不存在或尚未扫描；请先执行 scan',
                    {details: {icon_id: iconId}});
            sourcePath = String(group.source_path || '');
        }
        if (!sourcePath || !readBytes(sourcePath))
            throw new ControlError('STALE_SOURCE', '源素材已更新或删除；请刷新扫描',
                {details: {current_source_sha256: null}});
        const currentSha = shaHex(readBytes(sourcePath));
        if (args.source_sha256 && args.source_sha256 !== currentSha)
            throw new ControlError('STALE_SOURCE', '源素材已更新或删除；请刷新扫描',
                {details: {current_source_sha256: currentSha}});

        const pixbuf = loadPixbuf(sourcePath);
        const metrics = analyze(pixbuf);
        const rules = this.userRules();
        const classified = classifySourceEx(iconName, currentSha, metrics,
            this.overrides(), rules, {});
        const cls = classified.result.cls;
        const [rawRule] = lookupRuleEx(rules, iconName, {});
        const skipped = Boolean(rawRule && rawRule.skip);
        const [, ruleState] = describeRule(rawRule, currentSha, null);
        const stale = Boolean(rawRule && rawRule.classification
            && rawRule.classification !== 'auto' && rawRule.source_sha256
            && rawRule.source_sha256 !== currentSha);
        const decision = plan(metrics, cls, target, deadband, inner);
        const action = skipped ? 'skipped' : decision.action;

        // The "original" card shows the source artwork fitted to the preview
        // size; slot_original() semantics of the Python preview.
        const original = isVectorLike(sourcePath)
            ? loadPixbufScaled(sourcePath, size)
            : fitPixbuf(pixbuf, size);
        let proposed = original;
        const info = {source_ratio: metrics.source_ratio};
        if (!skipped && action !== 'keep') {
            const normalized = normalize(pixbuf, metrics, cls, {size, target, inner});
            proposed = normalized.pixbuf;
            info.target_ratio = target;
            info.size = size;
            info.measured_after_ratio = round4(analyze(proposed).source_ratio);
        } else {
            info.note = skipped
                ? 'skipped: vendor artwork at this size'
                : 'within deadband or excluded: no candidate';
        }

        return {
            effective_policy: {target, deadband, inner},
            saved_revision: this.revision(),
            icon_id: iconId || shaHex(iconName),
            icon_name: iconName,
            source_sha256: currentSha,
            action,
            skipped,
            classification: cls,
            classification_origin: classified.result.confidence === 'user' ? 'user'
                : classified.result.confidence === 'reviewed' ? 'reviewed' : 'automatic',
            classification_stale: stale || ruleState === 'stale_source',
            size,
            metrics: info,
            original_png_base64: pngBase64(original),
            proposed_png_base64: pngBase64(proposed),
        };
    }

    /**
     * Set or reset one icon rule.
     *
     * @param {object} args protocol arguments
     * @returns {Promise<object>}
     */
    async rulesSet(args) {
        return this.#locked(async () => {
            this.#requireRevision(args);
            const rules = this.userRules();
            const key = String(args.icon_id || '');
            if (args.rule && args.rule.reset) {
                delete rules[key];
            } else if (args.rule && args.rule.skip) {
                rules[key] = {skip: true};
                if (args.rule.keep_desktop_override) rules[key].keep_desktop_override = true;
            } else if (args.rule) {
                const cls = args.rule.classification || args.rule.class;
                if (cls && !CLASSES.includes(cls) && cls !== 'auto')
                    throw new Error('invalid classification: ' + cls);
                rules[key] = {skip: false};
                if (cls) rules[key].classification = cls;
                if (args.rule.source_sha256) rules[key].source_sha256 = args.rule.source_sha256;
            }
            writeJson(GLib.build_filenamev([this.stateDir, 'user-rules.json']), {icons: rules});
            return {revision: this.revision(), rule: rules[key] || null};
        });
    }

    /**
     * Persist a policy change.
     *
     * @param {{policy?: object, expected_revision?: string}} args
     * @returns {Promise<object>}
     */
    async configure(args = {}) {
        return this.#locked(async () => {
            this.#requireRevision(args);
            // The protocol (and every caller in prefs/) sends a *patch*, not a
            // whole policy: merge it onto the current values before validating.
            const current = this.policy();
            const policy = applyPatch(current, args.patch);
            const changed = policy.target !== current.target
                || policy.deadband !== current.deadband
                || policy.inner !== current.inner;
            if (changed) {
                writeJson(GLib.build_filenamev([this.stateDir, 'config.json']),
                    {policy, theme_name: 'DockNormalized', theme_dir: this.themeDir,
                        state_dir: this.stateDir, user_applications: this.appsDir});
            }
            return {revision: this.revision(), effective_policy: policy, changed};
        });
    }

    /** @returns {object} doctor payload */
    doctor() {
        const checks = {};
        const engine = this.engine();
        checks.theme = {ok: readBytes(GLib.build_filenamev([this.themeDir, 'index.theme']))
            !== null};
        checks.rules = {ok: true, user_rules: Object.keys(this.userRules()).length,
            reviewed_overrides: Object.keys(this.overrides()).length, warnings: 0, errors: []};
        checks.dependencies = {ok: true, missing: []};
        checks.cache = {ok: engine.cacheValid()};
        return {ok: true, checks};
    }

    /** @returns {Promise<object>} revert payload */
    async revert() {
        return this.#locked(() => this.engine().revert());
    }

    /** @returns {ProfilesStore} named profile catalogue */
    get profiles() {
        return new ProfilesStore(this.stateDir);
    }

    /** @returns {ThemeFollowStore} theme-follow flag */
    get themeFollowStore() {
        return new ThemeFollowStore(this.stateDir);
    }

    /**
     * Mark the selected source theme as followed.
     *
     * @param {{enabled?: boolean}} args
     * @returns {Promise<object>}
     */
    async themeFollow(args = {}) {
        return this.#locked(() => {
            this.themeFollowStore.setEnabled(Boolean(args.enabled));
            return {ok: true, enabled: Boolean(args.enabled),
                theme_follow: Boolean(args.enabled)};
        });
    }

    /**
     * Re-apply the overlay after the source theme changed.
     *
     * @returns {Promise<object>}
     */
    async themeSync() {
        if (!this.themeFollowStore.enabled())
            return {ok: true, changed: false, synced: false,
                source_theme: this.policy().base_theme};
        // apply() takes the lock itself: do not wrap this call in #locked.
        const payload = await this.apply({activate: false});
        return {ok: true, changed: (payload.file_operations || 0) > 0, synced: true,
            revision: this.revision(), source_theme: this.policy().base_theme};
    }

    /**
     * Persist the automatic-maintenance preference.
     *
     * The in-process engine has no systemd units: the Shell extension runs the
     * periodic pass itself and reports liveness through a heartbeat file, so the
     * UI can tell 'on' from 'on but stale'.
     *
     * @param {{enabled?: boolean}} args
     * @returns {Promise<object>}
     */
    async automationSet(args = {}) {
        const enabled = Boolean(args.enabled);
        return this.#locked(() => {
            writeJson(GLib.build_filenamev([this.stateDir, 'automation.json']),
                {schema_version: 1, enabled});
            return {ok: true, enabled, units: this.unitsStatus()};
        });
    }

    /**
     * Record that a maintenance pass just finished.
     *
     * @param {boolean} ok whether the pass committed cleanly
     * @param {string|null} code protocol error code when it did not
     */
    recordHeartbeat(ok, code = null) {
        writeJson(GLib.build_filenamev([this.stateDir, 'maintenance-heartbeat.json']),
            {schema_version: 1, ok: Boolean(ok), code, at_unix: Date.now() / 1000});
    }

    /** @returns {string|null} error code of the last failed pass, if any */
    maintenanceError() {
        const heartbeat = readJson(
            GLib.build_filenamev([this.stateDir, 'maintenance-heartbeat.json']));
        if (!heartbeat || heartbeat.ok !== false) return null;
        return heartbeat.code || 'UNKNOWN';
    }

    /** @returns {boolean} persisted automatic-maintenance preference */
    automationEnabled() {
        const raw = readJson(GLib.build_filenamev([this.stateDir, 'automation.json']));
        if (!raw || typeof raw.enabled !== 'boolean') return false;
        return raw.enabled;
    }

    /**
     * Units-shaped status for the maintenance page.
     *
     * @returns {object} automatic plus per-trigger detail
     */
    unitsStatus() {
        const enabled = this.automationEnabled();
        const heartbeat = readJson(
            GLib.build_filenamev([this.stateDir, 'maintenance-heartbeat.json']));
        const ageHours = heartbeat && heartbeat.at_unix
            ? (Date.now() / 1000 - heartbeat.at_unix) / 3600 : null;
        // A Shell that never ran a pass is 'unknown'; one that ran recently is on.
        const automatic = !enabled ? 'off' : (ageHours === null ? 'unknown' : 'on');
        return {automatic, enabled, last_pass_hours_ago: ageHours};
    }

    /**
     * Save a named profile (protocol operation profiles.save).
     *
     * @param {object} args
     * @returns {Promise<object>}
     */
    async profilesListSave(args = {}) {
        return this.#locked(() => this.profiles.save(args));
    }

    /**
     * Delete a named profile (protocol operation profiles.delete).
     *
     * @param {object} args
     * @returns {Promise<object>}
     */
    async profilesListDelete(args = {}) {
        return this.#locked(() => this.profiles.delete(args));
    }

    /**
     * Dispatch one protocol operation.
     *
     * @param {string} operation
     * @param {object} args
     * @returns {Promise<object>} result payload
     */
    async handle(operation, args = {}) {
        switch (operation) {
        case 'status': return this.status();
        case 'scan': return this.scan();
        case 'apply': return this.apply(args);
        case 'preview': return this.preview(args);
        case 'rules.set': return this.rulesSet(args);
        case 'configure': return this.configure(args);
        case 'doctor': return this.doctor();
        case 'revert': return this.revert();
        case 'theme.sync': return this.themeSync();
        case 'theme.follow': return this.themeFollow(args);
        case 'automation.set': return this.automationSet(args);
        case 'profiles.list': return this.profiles.catalog();
        case 'profiles.save': return this.profilesListSave(args);
        case 'profiles.delete': return this.profilesListDelete(args);
        default: throw new Error('unsupported operation: ' + operation);
        }
    }
}

/** @param {string} path candidate file path */
function isVectorLike(path) {
    return /\.svgz?$/i.test(path);
}

/** Round to 4 decimals, matching the Python preview payload. */
function round4(value) {
    return Math.round(value * 10000) / 10000;
}

/**
 * Fit a pixbuf inside size×size, keeping its aspect ratio (like PIL thumbnail).
 *
 * @param {object} pixbuf source GdkPixbuf
 * @param {number} size target box edge
 * @returns {object} new GdkPixbuf
 */
function fitPixbuf(pixbuf, size) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const scale = Math.min(size / width, size / height, 1);
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    if (outWidth === width && outHeight === height) return pixbuf;
    return pixbuf.scale_simple(outWidth, outHeight, GdkPixbuf.InterpType.BILINEAR);
}

/**
 * Load a file fitted to size×size (vector sources rasterize at the size).
 *
 * @param {string} path file path
 * @param {number} size target box edge
 * @returns {object} new GdkPixbuf
 */
function loadPixbufScaled(path, size) {
    return fitPixbuf(loadPixbuf(path), size);
}

/** @param {object} pixbuf GdkPixbuf */
function pngBase64(pixbuf) {
    const [, buffer] = pixbuf.save_to_bufferv('png', [], []);
    return GLib.base64_encode(new Uint8Array(buffer));
}
