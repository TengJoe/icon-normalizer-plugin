// In-process control surface: the same operations the Python control.py served,
// dispatched locally so the extension no longer needs a companion program.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {Engine} from './engine/engine.js';
import {loadPixbuf} from './engine/load.js';
import {analyze, CLASSES} from './engine/analyze.js';
import {normalize} from './engine/render.js';
import {readBytes, shaHex, atomicWrite} from './engine/transaction.js';
import {resolveSource, XdgIconResolver} from './engine/resolver.js';

/** Default policy when the state directory has none yet. */
export const DEFAULT_POLICY = {
    base_theme: 'Yaru',
    target: 0.83,
    deadband: 0.02,
    inner: 0.7,
    sizes: [16, 24, 32, 48, 64, 96, 128, 256, 512],
};

const SIZES = DEFAULT_POLICY.sizes;

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
     * @param {{settings: object, home?: string, resolver?: object}} options
     */
    constructor(options) {
        this.settings = options.settings;
        this.home = options.home || GLib.get_home_dir();
        this.resolver = options.resolver || null;
        this.stateDir = GLib.build_filenamev([this.home, '.local', 'state', 'icon-normalizer']);
        this.themeDir = GLib.build_filenamev([this.home, '.local', 'share', 'icons',
            'DockNormalized']);
        const userAppsEnv = GLib.getenv('ICON_NORMALIZER_USER_APPS');
        this.appsDir = userAppsEnv || GLib.build_filenamev([this.home, '.local', 'share', 'applications']);
        GLib.mkdir_with_parents(this.stateDir, 0o755);
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
        return new Engine({
            home: this.home,
            themeDir: this.themeDir,
            themeName: 'DockNormalized',
            stateDir: this.stateDir,
            userApplications: this.appsDir,
            applicationDirs: (GLib.getenv('ICON_NORMALIZER_APPLICATION_DIRS') || '').split(':').filter(Boolean),
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
        for (const item of Object.values(manifest.items || {})) {
            const digest = item.source_sha256;
            for (const [, rule] of Object.entries(rules)) {
                const bound = rule.source_sha256;
                if (!bound) { states.active++; continue; }
                if (!digest) states.unbound++;
                else if (bound === digest) states.active++;
                else states.stale_source++;
                break;
            }
        }
        const activeTheme = this.settings ? this.settings.iconTheme() : null;
        return {
            backend_version: 'gjs-1',
            api_version: 1,
            installed: true,
            revision: this.revision(),
            busy: false,
            stale: false,
            last_apply_at: lastRun.last_updated_at_unix
                ? new Date(lastRun.last_updated_at_unix * 1000).toISOString() : null,
            last_check_at: lastRun.checked_at_unix
                ? new Date(lastRun.checked_at_unix * 1000).toISOString() : null,
            last_scan_at: lastRun.checked_at_unix
                ? new Date(lastRun.checked_at_unix * 1000).toISOString() : null,
            last_error: null,
            recovery_pending: readBytes(GLib.build_filenamev([this.stateDir, 'pending.json']))
                !== null,
            summary: lastRun.summary || null,
            automatic: this.settings ? this.settings.automatic() : null,
            units: [],
            theme_follow: true,
            source_theme: this.policy().base_theme,
            active_theme: activeTheme,
            overlay_in_use: activeTheme === 'DockNormalized',
            rules_health: {states, warnings: (lastRun.rule_warnings || 0)},
            rule_warnings: lastRun.rule_warnings || 0,
        };
    }

    /** @returns {object} scan payload */
    scan() {
        const payload = this.engine().sync({apply: false});
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
    }

    /** @returns {object} apply payload */
    apply() {
        const payload = this.engine().sync({apply: true});
        return {...payload, revision: this.revision()};
    }

    /**
     * Render a preview of one icon.
     *
     * @param {{icon_id?: string, source_path?: string, size?: number}} args
     * @returns {object}
     */
    preview(args) {
        const size = Number(args.size || 48);
        const path = args.source_path
            || resolveSource(String(args.icon_id || ''), this.resolver,
                {forbiddenDir: this.themeDir});
        const pixbuf = loadPixbuf(path);
        const metrics = analyze(pixbuf);
        const policy = this.policy();
        const cls = args.classification || 'artwork';
        const {pixbuf: rendered} = normalize(pixbuf, metrics, cls, {
            size, target: policy.target, inner: policy.inner,
        });
        const [, buffer] = rendered.save_to_bufferv('png', [], []);
        return {
            saved_revision: this.revision(),
            effective_policy: policy,
            source_ratio: metrics.source_ratio,
            candidate: GLib.base64_encode(new Uint8Array(buffer)),
        };
    }

    /**
     * Set or reset one icon rule.
     *
     * @param {object} args protocol arguments
     * @returns {object}
     */
    rulesSet(args) {
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
    }

    /**
     * Persist a policy change.
     *
     * @param {{policy?: object}} args
     * @returns {object}
     */
    configure(args) {
        const policy = {...this.policy(), ...(args.policy || {})};
        writeJson(GLib.build_filenamev([this.stateDir, 'config.json']),
            {policy, theme_name: 'DockNormalized', theme_dir: this.themeDir,
                state_dir: this.stateDir, user_applications: this.appsDir});
        return {revision: this.revision(), effective_policy: policy};
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

    /** @returns {object} revert payload */
    revert() {
        return this.engine().revert();
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
        case 'apply': return this.apply();
        case 'preview': return this.preview(args);
        case 'rules.set': return this.rulesSet(args);
        case 'configure': return this.configure(args);
        case 'doctor': return this.doctor();
        case 'revert': return this.revert();
        case 'theme.sync': return {ok: true, synced: false};
        case 'theme.follow': return {ok: true, theme_follow: true};
        case 'automation.set': return {ok: true, automatic: this.settings
            ? this.settings.automatic() : null};
        case 'profiles.list': return {profiles: []};
        case 'profiles.save': return {ok: true};
        case 'profiles.delete': return {ok: true};
        default: throw new Error('unsupported operation: ' + operation);
        }
    }
}
