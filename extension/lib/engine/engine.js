// Overlay theme engine: collect, inspect, sync and revert.
// Port of backend/icon_normalizer/core/engine.py.
//
// The caller holds the sync lock (SyncLock in transaction.js). The heavy phases
// of inspect() are exposed as a generator so a host can slice them across idle
// callbacks (syncAsync); Engine.sync() drains the same generator synchronously
// for tests and non-interactive callers.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {analyze, plan, suggestClass} from './analyze.js';
import {ALERT_RULE_STATES, classifySourceEx, describeRule, lookupRuleEx} from './classification.js';
import {
    collectDesktopEntries, readDesktopSection, rewriteIconLine,
    safeReadDesktopSection, safeRewriteIconLine,
} from './desktop.js';
import {loadPixbuf} from './load.js';
import {normalize} from './render.js';
import {resolveSource} from './resolver.js';
import {MARKER, MARKER_FILE, MANIFEST_VERSION, ThemeDirectory, themeIndex} from './theme.js';
import {
    TransactionStore, atomicWrite, readBytes, shaHex, underRoot,
} from './transaction.js';

/** Base64 of a byte array, or null. */
const b64 = data => (data === null || data === undefined ? null : GLib.base64_encode(data));

/** Parse JSON from a file, returning null when it is absent or unreadable. */
function readJson(path) {
    const bytes = readBytes(path);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

/** Encode JSON the way the Python engine does. */
function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

/** Encode a pixbuf as PNG bytes. */
function pngBytes(pixbuf) {
    const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok) throw new Error('PNG encoding failed');
    return new Uint8Array(buffer);
}

/** Drain a generator synchronously, returning its final value. */
function drainSync(generator) {
    let next;
    do { next = generator.next(); } while (!next.done);
    return next.value;
}

/**
 * Drive a generator across idle callbacks, processing units of work in
 * time-boxed slices so the host main loop (gnome-shell) keeps painting.
 *
 * @param {Iterator} generator yields between units of work
 * @param {number} sliceMs wall-clock budget per idle callback
 * @param {number} [generation] cancel token: when the caller's generation
 *   changes mid-run the driver keeps going but the caller discards the result.
 * @returns {Promise<object>} the generator's final value
 */
export function driveSliced(generator, sliceMs = 20) {
    return new Promise((resolve, reject) => {
        const step = () => {
            try {
                const deadline = Date.now() + sliceMs;
                let next = generator.next();
                while (!next.done && Date.now() < deadline) next = generator.next();
                if (next.done) { resolve(next.value); return GLib.SOURCE_REMOVE; }
                return GLib.SOURCE_CONTINUE;
            } catch (error) {
                reject(error);
                return GLib.SOURCE_REMOVE;
            }
        };
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
    });
}

// Shared rendering-core version; must match backend version.py CORE_VERSION.
// tools/parity.py asserts the two engines derive identical fingerprints.
const CORE_VERSION = '3';

/** Sort keys and join compactly, matching Python json.dumps(sort_keys=True,
 * ensure_ascii=False, separators=(",", ":")). */
function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value !== null && typeof value === 'object') {
        return '{' + Object.keys(value).sort()
            .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

/**
 * Engine-agnostic policy fingerprint, byte-identical to the Python engine's
 * policy_fingerprint (backend/icon_normalizer/fingerprints.py): the strategy
 * keys only, canonically serialized, plus the shared core version. The Shell
 * scheduler and the optional Python worker both write the manifest — a
 * fingerprint only one engine can derive would make every run re-render
 * everything.
 *
 * @param {object} policy strategy {target, deadband, inner, sizes, base_theme}
 * @returns {string} hex sha-256
 */
export function policyFingerprint(policy) {
    return shaHex(canonicalJson({
        base_theme: policy.base_theme,
        deadband: policy.deadband,
        inner: policy.inner,
        sizes: policy.sizes,
        target: policy.target,
    }) + CORE_VERSION);
}

export class Engine {
    /**
     * @param {object} config engine configuration
     */
    constructor(config) {
        this.config = config;
        if (config.policy.base_theme === config.themeName)
            throw new Error('Source and generated theme must be different');
        this.themeDir = config.themeDir;
        this.stateDir = config.stateDir;
        this.appsDir = config.userApplications;
        this.baseTheme = config.policy.base_theme;
        this.themeName = config.themeName;
        this.resolver = config.resolver || null;
        this.themedir = new ThemeDirectory(this.themeDir, this.themeName);
        this.store = new TransactionStore(
            GLib.build_filenamev([this.stateDir, 'pending.json']),
            [
                {path: this.themeDir, fileMode: 0o644},
                {path: this.stateDir, fileMode: 0o600},
                {path: this.appsDir, fileMode: 0o644},
            ],
            changed => this.finalizeCache(changed));
        this.policySha = policyFingerprint(config.policy);
        this.analysisPolicy = shaHex(this.policySha
            + JSON.stringify(config.overrides || {})
            + JSON.stringify(config.userRules || {}));
    }

    /** @returns {object} the manifest, defaulted when absent */
    manifest() {
        const path = GLib.build_filenamev([this.stateDir, 'manifest.json']);
        const parsed = readJson(path);
        if (!parsed || typeof parsed !== 'object')
            return {version: MANIFEST_VERSION, base_theme: this.baseTheme,
                items: {}, desktop_overrides: {}};
        return parsed;
    }

    /**
     * @param {string} path candidate output
     * @returns {string} the path when inside a protected root
     */
    allowed(path) {
        return this.store.allowed(path);
    }

    /** @returns {boolean} */
    cacheValid() {
        return this.themedir.cacheValid();
    }

    /** @returns {boolean} */
    recover() {
        return this.store.recover();
    }

    /** Rebuild the icon cache when the theme tree changed. */
    finalizeCache(changedTheme) {
        if (!changedTheme) return;
        if (!this.themedir.owned()) return;
        this.themedir.rebuild();
    }

    /**
     * Record the current digest of a path, rejecting a change since inspection.
     *
     * @param {Map<string, string|null>} expected
     * @param {string} path
     * @param {Uint8Array|null} current
     */
    rememberBefore(expected, path, current) {
        const digest = current === null ? null : shaHex(current);
        if (expected.has(path) && expected.get(path) !== digest)
            throw new Error('changed_since_inspection: ' + path);
        expected.set(path, digest);
    }

    /**
     * Conflicts among files this engine previously owned.
     *
     * @param {object} old previous manifest
     * @param {Map<string, string|null>} expected
     * @returns {string[]} conflicting paths
     */
    ownedIconConflicts(old, expected) {
        const conflicts = [];
        for (const item of Object.values(old.items || {})) {
            for (const [name, digest] of Object.entries(item.files || {})) {
                const target = this.allowed(name);
                const current = readBytes(target);
                this.rememberBefore(expected, target, current);
                if (current !== null && shaHex(current) !== digest) conflicts.push(target);
            }
        }
        return conflicts;
    }

    /**
     * Transform a desktop entry whose launcher this engine generated.
     *
     * @param {object} managed previous desktop_overrides
     * @returns {Function} transform
     */
    entryTransform(managed) {
        return (path, entry) => {
            try {
                const record = managed[path];
                if (!record) return entry;
                const data = readBytes(path);
                if (!data || entry.Icon !== record.output_icon) return entry;
                if (record.original_existed)
                    return readDesktopSection(new TextEncoder().encode(
                        rewriteIconLine(data, record.source_icon)));
                const source = record.source_desktop;
                if (!readBytes(source)) return null;
                if (shaHex(data) !== record.output_sha256)
                    return readDesktopSection(new TextEncoder().encode(
                        rewriteIconLine(data, record.source_icon)));
                return readDesktopSection(readBytes(source));
            } catch {
                // Unreadable or unparseable launcher: keep the current entry
                // instead of failing the whole run (DESKTOP_PARSE_ERROR is
                // reported separately by collect()).
                return entry;
            }
        };
    }

    /**
     * @param {object} old previous manifest
     * @returns {object} collectDesktopEntries result
     */
    collect(old) {
        // An empty applicationDirs list means "use the XDG roots"; passing it
        // through would shadow every real directory with nothing.
        return collectDesktopEntries(this.config.desktop, this.config.home, {
            applicationDirs: (this.config.applicationDirs && this.config.applicationDirs.length)
                ? this.config.applicationDirs : undefined,
            entryTransform: this.entryTransform(old.desktop_overrides || {}),
        });
    }

    /**
     * Analyse one source.
     *
     * @param {string} icon
     * @param {string} path
     * @param {string} digest
     * @param {Record<string, string>} pathByKey
     * @returns {object}
     */
    analyzeOne(icon, path, digest, pathByKey) {
        const pixbuf = loadPixbuf(path);
        const metrics = analyze(pixbuf);
        const result = classifySourceEx(icon, digest, metrics,
            this.config.overrides || {}, this.config.userRules || {}, pathByKey);
        return {
            metrics,
            cls: result.result.cls,
            reason: result.result.reason,
            confidence: result.result.confidence,
            autoClass: result.automatic,
            cacheEntry: {
                key: shaHex(path + digest + this.analysisPolicy),
                metrics,
                class: result.result.cls,
                reason: result.result.reason,
                confidence: result.result.confidence,
            },
        };
    }

    /**
     * Render the requested sizes of one source.
     *
     * @param {string} path
     * @param {object} metrics
     * @param {string} cls
     * @param {number[]} sizes
     * @returns {Record<number, {bytes: Uint8Array, info: object}>}
     */
    renderSizes(path, metrics, cls, sizes) {
        const pixbuf = loadPixbuf(path);
        const policy = this.config.policy;
        const out = {};
        for (const size of sizes) {
            const {pixbuf: rendered, info} = normalize(pixbuf, metrics, cls, {
                size, target: policy.target, inner: policy.inner,
            });
            out[size] = {bytes: pngBytes(rendered), info};
        }
        return out;
    }

    /**
     * Ownership checks for every managed target.
     *
     * @returns {number[]} sizes that still need rendering
     */
    verifyTargets(icon, outputName, sizes, prior, reusable, conflicts, expected) {
        const missing = [];
        const priorFiles = (prior || {}).files || {};
        for (const size of sizes) {
            const target = GLib.build_filenamev(
                [this.themeDir, size + 'x' + size, 'apps', outputName + '.png']);
            const priorSha = priorFiles[target];
            const current = readBytes(target);
            this.rememberBefore(expected, target, current);
            if (current !== null && priorSha === undefined) conflicts.push(target + ':unowned');
            else if (current !== null && priorSha !== shaHex(current))
                conflicts.push(target + ':changed');
            if (!(reusable && current !== null)) missing.push(size);
        }
        return missing;
    }

    /**
     * Materialize one icon: theme files, versioned copy and desktop overrides.
     */
    materialize(record, sizes, rendered, old, items, changes, desiredDesktops,
        usedOverrides, backupData, expected) {
        const priorFiles = (record.prior || {}).files || {};
        const files = {};
        const renders = {};
        for (const size of sizes) {
            const target = GLib.build_filenamev(
                [this.themeDir, size + 'x' + size, 'apps', record.outputName + '.png']);
            const current = readBytes(target);
            this.rememberBefore(expected, target, current);
            let result;
            if (record.reusable && current !== null) {
                result = current;
                renders[String(size)] = ((record.prior || {}).renders || {})[String(size)] || {};
            } else {
                if (!rendered[size])
                    throw new Error('Render output missing for ' + target);
                result = rendered[size].bytes;
                renders[String(size)] = rendered[size].info;
            }
            files[target] = shaHex(result) || '';
            if (shaHex(current) !== shaHex(result)) changes.set(target, result);
        }
        items[record.icon] = {
            input_key: record.inputKey,
            source_path: record.path,
            source_sha256: record.digest,
            class: record.cls,
            files,
            renders,
            names: record.names,
        };
        if (!record.icon.startsWith('/')) return;

        // Absolute-path icons also get a content-addressed copy and per-launcher
        // overrides under the user applications directory.
        const candidate = GLib.build_filenamev(
            [this.themeDir, '256x256', 'apps', record.outputName + '.png']);
        const renderedCandidate = changes.get(candidate) || readBytes(candidate);
        if (!renderedCandidate)
            throw new Error('Rendered candidate missing for ' + candidate);
        const versioned = GLib.build_filenamev([this.themeDir, '256x256', 'apps',
            record.outputName + '-' + shaHex(renderedCandidate).slice(0, 16) + '.png']);
        const known = priorFiles[versioned];
        const versionedCurrent = readBytes(versioned);
        this.rememberBefore(expected, versioned, versionedCurrent);
        if (versionedCurrent !== null && known === undefined)
            throw new Error('unowned_collision: ' + versioned);
        if (versionedCurrent !== null && shaHex(versionedCurrent) !== known)
            throw new Error('changed_since_inspection: ' + versioned);
        if (versionedCurrent === null) changes.set(versioned, renderedCandidate);
        files[versioned] = shaHex(renderedCandidate) || '';

        const oldOverrides = old.desktop_overrides || {};
        for (const ref of record.refs) {
            if (ref.visibility !== 'visible') continue;
            const target = GLib.build_filenamev([this.appsDir, ref.desktop_id]);
            const source = ref.desktop_path;
            const previous = oldOverrides[target];
            const current = readBytes(target);
            this.rememberBefore(expected, target, current);
            let original, existed, origin;
            if (previous) {
                if (current === null) {
                    original = GLib.base64_decode(previous.original_data);
                    existed = previous.original_existed;
                    origin = previous.source_desktop;
                } else if ((safeReadDesktopSection(current) || {}).Icon
                    === previous.output_icon) {
                    if (previous.original_existed || shaHex(current) !== previous.output_sha256) {
                        original = new TextEncoder().encode(
                            rewriteIconLine(current, record.icon));
                        existed = true;
                        origin = target;
                    } else {
                        origin = previous.source_desktop;
                        original = readBytes(origin);
                        existed = false;
                    }
                } else {
                    original = current;
                    existed = true;
                    origin = target;
                }
            } else {
                original = (source === target && current !== null) ? current : readBytes(source);
                existed = source === target;
                origin = source;
                if (readBytes(target) && !existed)
                    throw new Error('unowned_collision: ' + target);
            }
            const edited = new TextEncoder().encode(rewriteIconLine(original, versioned));
            desiredDesktops[target] = {
                source_icon: record.icon,
                output_icon: versioned,
                original_existed: existed,
                source_desktop: origin,
                original_data: b64(original),
                original_sha256: shaHex(original),
                output_sha256: shaHex(edited),
            };
            usedOverrides.add(target);
            if (shaHex(current) !== shaHex(edited)) changes.set(target, edited);
            backupData[GLib.build_filenamev(
                [this.stateDir, 'backups', 'desktop-' + shaHex(original) + '.before'])] = original;
        }
    }

    /** Handle a skipped icon: drop its outputs and restore its launchers. */
    applySkip(icon, path, digest, row, old, items, desiredDesktops, changes,
        usedOverrides, keepDesktop = false) {
        const prior = (old.items || {})[icon];
        if (!prior) return;
        for (const [p, priorDigest] of Object.entries(prior.files || {})) {
            const current = readBytes(p);
            if (current !== null && shaHex(current) === priorDigest) changes.set(p, null);
        }
        for (const [target, record] of Object.entries(old.desktop_overrides || {})) {
            if (record.source_icon !== icon) continue;
            if (keepDesktop) { usedOverrides.add(target); continue; }
            const current = readBytes(target);
            if (current === null) {
                if (record.original_existed)
                    changes.set(target, GLib.base64_decode(record.original_data));
            } else if ((safeReadDesktopSection(current) || {}).Icon === record.output_icon) {
                const restored = safeRewriteIconLine(current, record.source_icon);
                if (restored) changes.set(target, new TextEncoder().encode(restored));
            }
        }
        for (const key of Object.keys(desiredDesktops))
            if (desiredDesktops[key].source_icon === icon) delete desiredDesktops[key];
        items[icon] = {
            input_key: 'skipped:' + shaHex(path + digest),
            source_path: path,
            source_sha256: digest,
            class: null,
            files: {},
            renders: {},
            names: row.names,
        };
    }

    /** Keep the previous generation when a source cannot be read right now. */
    retainPrevious(icon, names, desktopIds, error, old, oldCache, items,
        analysisCache, desiredDesktops, usedOverrides, rows, unresolved) {
        unresolved.push({icon_name: icon, error});
        const prior = (old.items || {})[icon];
        if (prior) {
            items[icon] = prior;
            if (oldCache[icon]) analysisCache[icon] = oldCache[icon];
            for (const [target, record] of Object.entries(old.desktop_overrides || {})) {
                if (record.source_icon === icon) {
                    desiredDesktops[target] = record;
                    usedOverrides.add(target);
                }
            }
        }
        rows.push({
            icon_name: icon, names, desktop_ids: desktopIds,
            action: prior ? 'retain_previous' : 'unresolved',
            reason: 'source_unavailable',
        });
    }

    /**
     * Plan the whole run without touching disk.
     *
     * Generator form: it yields between analysis and render jobs so a host can
     * slice the run across idle callbacks (driveSliced). Engine.inspect()
     * drains it synchronously for tests and tools.
     *
     * @yields {null} between per-icon units of work
     * @returns {{changes: Map<string, Uint8Array|null>, manifest: object,
     *            payload: object, expectedBefore: Map<string, string|null>}}
     */
    *inspectGenerator() {
        const expected = new Map();
        for (const path of [
            GLib.build_filenamev([this.stateDir, 'manifest.json']),
            GLib.build_filenamev([this.stateDir, 'config.json']),
            GLib.build_filenamev([this.stateDir, 'baseline.json']),
            GLib.build_filenamev([this.themeDir, 'index.theme']),
            GLib.build_filenamev([this.themeDir, MARKER_FILE]),
        ]) {
            this.allowed(path);
            this.rememberBefore(expected, path, readBytes(path));
        }
        const old = this.manifest();
        for (const name of Object.keys(old.desktop_overrides || {})) {
            const target = this.allowed(name);
            this.rememberBefore(expected, target, readBytes(target));
        }
        const owned = this.themedir.owned();
        const collected = this.collect(old);

        const items = {};
        const analysisCache = {};
        const rows = [];
        const unresolved = [];
        const ruleWarnings = [];
        // A single unparseable .desktop must not disable the whole run: report
        // it as a warning and process the rest (the file keeps its old state).
        for (const failure of collected.errors) {
            ruleWarnings.push({
                icon_name: '', names: [], error: 'DESKTOP_PARSE_ERROR',
                rule_key: shaHex(failure.desktop_path || ''),
                detail: failure,
            });
        }
        const changes = new Map();
        const desiredDesktops = {};
        const usedOverrides = new Set();
        const backupData = {};

        const oldCache = old.analysis_cache || {};
        const oldItems = old.items || {};
        // Previous source paths let a rule follow its icon when an application
        // re-exports the same artwork into a different size directory.
        const previousPaths = {};
        for (const [key, item] of Object.entries(oldItems)) {
            if (!item || !item.source_path) continue;
            previousPaths[key] = String(item.source_path);
            previousPaths[shaHex(key)] = String(item.source_path);
        }
        const policy = this.config.policy;
        const sizes = policy.sizes;

        const conflicts = this.ownedIconConflicts(old, expected);
        const order = [];
        const refsByIcon = {};
        const resolved = {};
        const analysisJobs = [];
        const analysisFailures = {};

        // ---- phase A: exclusions, resolution, analysis-cache dispatch ----
        for (const [icon, refs] of Object.entries(collected.grouped).sort()) {
            order.push(icon);
            yield null; // source digesting dominates this phase: one icon per unit
            if (!refs.some(ref => ref.visibility === 'visible')) {
                rows.push({icon_name: icon, action: 'excluded',
                    names: refs.map(r => r.name), desktop_ids: refs.map(r => r.desktop_id)});
                continue;
            }
            refsByIcon[icon] = refs;
            let path, digest;
            try {
                path = resolveSource(icon, this.resolver, {forbiddenDir: this.themeDir});
                digest = shaHex(readBytes(path));
            } catch (error) {
                analysisFailures[icon] = String(error && error.message || error);
                continue;
            }
            resolved[icon] = {path, digest};
            const analysisKey = shaHex(path + digest + this.analysisPolicy);
            const cached = oldCache[icon];
            if (cached && cached.key === analysisKey) analysisCache[icon] = cached;
            else analysisJobs.push({icon, path, digest});
        }

        // ---- phase B: analysis ----
        const analysisResults = {};
        for (const job of analysisJobs) {
            try {
                analysisResults[job.icon] = this.analyzeOne(
                    job.icon, job.path, job.digest, previousPaths);
            } catch (error) {
                analysisFailures[job.icon] = String(error && error.message || error);
            }
            yield null; // one analysis per unit
        }

        // ---- phase C: decisions, skips, render dispatch ----
        const plans = {};
        const renderJobs = [];
        for (const icon of order) {
            if (!refsByIcon[icon]) continue;
            const refs = refsByIcon[icon];
            const names = refs.map(r => r.name);
            const desktopIds = refs.map(r => r.desktop_id);
            if (analysisFailures[icon]) {
                this.retainPrevious(icon, names, desktopIds, analysisFailures[icon], old,
                    oldCache, items, analysisCache, desiredDesktops, usedOverrides,
                    rows, unresolved);
                continue;
            }
            const {path, digest} = resolved[icon];
            const analysis = analysisResults[icon];
            let metrics, cls, reason, confidence, autoClass;
            if (analysis) {
                metrics = analysis.metrics;
                cls = analysis.cls;
                reason = analysis.reason;
                confidence = analysis.confidence;
                analysisCache[icon] = analysis.cacheEntry;
                autoClass = analysis.autoClass || cls;
            } else {
                const cached = analysisCache[icon];
                metrics = cached.metrics;
                cls = cached.class;
                reason = cached.reason;
                confidence = cached.confidence;
                autoClass = cls;
            }
            const decision = plan(metrics, cls, policy.target, policy.deadband, policy.inner);
            const row = {
                icon_name: icon,
                names,
                desktop_ids: desktopIds,
                source_path: path,
                source_sha256: digest,
                class: cls,
                classification_reason: reason,
                classification_confidence: confidence,
                auto_class: autoClass,
                source_ratio: metrics.source_ratio,
                suggested_class: suggestClass(metrics),
                action: decision.action,
                reason: decision.reason,
                target_ratio: decision.target_ratio,
                inner_target_ratio: decision.inner_target_ratio,
                scale: decision.scale,
            };
            const [rawRule, matchedBy] = lookupRuleEx(
                this.config.userRules || {}, icon, previousPaths);
            const [, ruleState, ruleDetail] = describeRule(rawRule, digest, matchedBy);
            row.rule_matched_by = matchedBy;
            row.rule_state = ruleState;
            if (ruleDetail && Object.keys(ruleDetail).length) row.rule_detail = ruleDetail;
            if (ALERT_RULE_STATES.has(ruleState)) {
                ruleWarnings.push({
                    icon_name: icon, names, error: 'RULE_' + ruleState.toUpperCase(),
                    rule_key: shaHex(icon), detail: ruleDetail,
                });
            }
            if (rawRule && rawRule.skip) {
                row.action = 'skipped';
                row.reason = 'user_skip';
                this.applySkip(icon, path, digest, row, old, items, desiredDesktops,
                    changes, usedOverrides, Boolean(rawRule.keep_desktop_override));
                rows.push(row);
                continue;
            }
            rows.push(row);
            if (decision.action === 'keep') continue;
            const absolute = icon.startsWith('/');
            if (!absolute && !/^[A-Za-z0-9._+-]+$/.test(icon)) {
                unresolved.push({icon_name: icon, error: 'Unsupported theme icon name'});
                continue;
            }
            const outputName = absolute ? 'docknormalized-' + shaHex(icon).slice(0, 16) : icon;
            const prior = oldItems[icon];
            const inputKey = shaHex(path + digest + cls + this.policySha);
            const reusable = Boolean(prior && prior.input_key === inputKey);
            const missing = this.verifyTargets(icon, outputName, sizes, prior, reusable,
                conflicts, expected);
            plans[icon] = {icon, path, digest, refs, names, metrics, cls, decision, row,
                outputName, inputKey, prior, reusable};
            if (missing.length) renderJobs.push({icon, path, metrics, cls, sizes: missing});
        }
        if (conflicts.length) throw new Error('conflicts: ' + conflicts.join(', '));

        // ---- phase D: rendering (the heaviest phase) ----
        const renderOutputs = {};
        for (const job of renderJobs) {
            renderOutputs[job.icon] = this.renderSizes(
                job.path, job.metrics, job.cls, job.sizes);
            yield null; // one full-icon render per unit
        }

        // ---- phase E: materialize ----
        for (const icon of order) {
            const record = plans[icon];
            if (!record) continue;
            this.materialize(record, sizes, renderOutputs[icon] || {}, old, items, changes,
                desiredDesktops, usedOverrides, backupData, expected);
        }

        // ---- phase F: stale cleanup + manifest ----
        const wanted = new Set();
        for (const item of Object.values(items))
            for (const p of Object.keys(item.files || {})) wanted.add(p);
        for (const item of Object.values(oldItems)) {
            for (const [p, digest] of Object.entries(item.files || {})) {
                if (wanted.has(p)) continue;
                const current = readBytes(p);
                if (current === null) continue;
                if (shaHex(current) !== digest)
                    throw new Error('changed_since_inspection: ' + p);
                changes.set(p, null);
            }
        }
        for (const [p, record] of Object.entries(old.desktop_overrides || {})) {
            if (usedOverrides.has(p)) continue;
            const current = readBytes(p);
            if (current === null) continue;
            if (shaHex(current) === record.output_sha256) {
                changes.set(p, record.original_existed
                    ? GLib.base64_decode(record.original_data) : null);
            } else if ((safeReadDesktopSection(current) || {}).Icon === record.output_icon) {
                const restored = safeRewriteIconLine(current, record.source_icon);
                if (restored)
                    changes.set(p, new TextEncoder().encode(restored));
            }
        }
        const manifest = {
            version: MANIFEST_VERSION,
            base_theme: this.baseTheme,
            policy_sha256: this.policySha,
            analysis_cache: analysisCache,
            items,
            desktop_overrides: desiredDesktops,
        };
        // The sweep only removes files this engine plausibly generated: names
        // tracked by the current or previous manifest, current output names,
        // and content-addressed versioned copies. Anything else — a user's
        // manual addition to the theme tree — is reported, not deleted.
        const managedNames = new Set();
        for (const item of [...Object.values(items), ...Object.values(oldItems)])
            for (const p of Object.keys(item.files || {}))
                managedNames.add(p.slice(p.lastIndexOf('/') + 1));
        for (const record of Object.values(plans))
            managedNames.add(record.outputName + '.png');
        for (const stale of this.themedir.pngs()) {
            if (wanted.has(stale)) continue;
            const name = stale.slice(stale.lastIndexOf('/') + 1);
            if (!managedNames.has(name) && !name.startsWith('docknormalized-')) {
                ruleWarnings.push({
                    icon_name: '', names: [], error: 'UNTRACKED_THEME_FILE',
                    rule_key: shaHex(stale), detail: {path: stale},
                });
                continue;
            }
            this.allowed(stale);
            this.rememberBefore(expected, stale, readBytes(stale));
            changes.set(stale, null);
        }
        const index = themeIndex(this.themeName, this.baseTheme, sizes);
        const indexPath = GLib.build_filenamev([this.themeDir, 'index.theme']);
        const indexBytes = new TextEncoder().encode(index);
        const currentIndex = readBytes(indexPath);
        if (!currentIndex || shaHex(currentIndex) !== shaHex(indexBytes))
            changes.set(indexPath, indexBytes);
        if (!owned)
            changes.set(GLib.build_filenamev([this.themeDir, MARKER_FILE]),
                new TextEncoder().encode(MARKER));
        for (const [p, data] of Object.entries(backupData))
            if (!readBytes(p)) changes.set(p, data);

        // Reviewed overrides are bound to the source fingerprint. When an
        // application replaces its artwork the override silently stops
        // applying; report it instead of hiding the visual regression.
        for (const [icon, override] of Object.entries(this.config.overrides || {}).sort()) {
            const wantedSha = override.source_sha256;
            if (!wantedSha) continue;
            let currentDigest;
            try {
                currentDigest = shaHex(readBytes(
                    resolveSource(icon, this.resolver, {forbiddenDir: this.themeDir})));
            } catch {
                continue;
            }
            if (currentDigest === wantedSha) continue;
            ruleWarnings.push({
                icon_name: icon, names: [], error: 'OVERRIDE_STALE_SOURCE',
                rule_key: shaHex(icon),
                detail: {expected_sha256: wantedSha, actual_sha256: currentDigest},
            });
        }

        const actionCounts = {};
        for (const row of rows)
            actionCounts[row.action] = (actionCounts[row.action] || 0) + 1;
        const summary = {
            candidate_icons: Object.keys(collected.grouped).length,
            visible_desktop_entries: collected.counts.visible || 0,
            actions: actionCounts,
            managed_icons: Object.keys(items).length,
            managed_desktop_overrides: Object.keys(desiredDesktops).length,
            unresolved,
            rule_warnings: ruleWarnings.length,
            planned_file_changes: changes.size,
            cache_valid: this.cacheValid(),
            source_theme: this.baseTheme,
            active_theme: this.config.settings ? this.config.settings.iconTheme() : null,
        };
        return {
            changes,
            manifest,
            expectedBefore: expected,
            payload: {ok: true, summary, warnings: unresolved, rule_warnings: ruleWarnings,
                apps: rows},
        };
    }

    /**
     * Plan the whole run without touching disk (synchronous drain).
     *
     * @returns {{changes: Map<string, Uint8Array|null>, manifest: object,
     *            payload: object, expectedBefore: Map<string, string|null>}}
     */
    inspect() {
        return drainSync(this.inspectGenerator());
    }

    /**
     * Write the planned changes, the manifest last.
     *
     * @param {object} result inspectGenerator() result
     * @param {boolean} recovered whether a pending journal was replayed
     * @returns {object} payload
     */
    #applyPlan(result, recovered) {

        if (!readBytes(GLib.build_filenamev([this.stateDir, 'baseline.json']))) {
            const baseline = {
                icon_theme: (this.config.settings && this.config.settings.iconTheme())
                    || this.baseTheme,
                config: {
                    policy: this.config.policy,
                    theme_name: this.themeName,
                    theme_dir: this.themeDir,
                    state_dir: this.stateDir,
                    user_applications: this.appsDir,
                    desktop: this.config.desktop,
                },
            };
            result.changes.set(GLib.build_filenamev([this.stateDir, 'baseline.json']),
                jsonBytes(baseline));
        }
        const manifestPath = GLib.build_filenamev([this.stateDir, 'manifest.json']);
        const commit = this.store.commit(result.changes, {
            committedLast: [manifestPath, jsonBytes(result.manifest)],
            expectedBefore: result.expectedBefore,
        });
        const payload = result.payload;
        payload.applied = true;
        payload.recovered_transaction = recovered;
        payload.file_operations = commit.operations;
        payload.theme_activation = 'not_requested';
        payload.summary.cache_valid = this.cacheValid();
        payload.summary.active_theme = this.config.settings
            ? this.config.settings.iconTheme() : null;
        payload.summary.theme_active = payload.summary.active_theme === this.themeName;

        const lastRunPath = GLib.build_filenamev([this.stateDir, 'last-run.json']);
        const previousRun = readJson(lastRunPath) || {};
        this.config.onHealthEvent?.(payload.rule_warnings.length
            ? {kind: 'degraded', code: 'RULE_STALE', operation: 'sync',
                count: payload.rule_warnings.length}
            : (previousRun.rule_warnings
                ? {kind: 'recovered', code: 'RULE_STALE', operation: 'sync', count: 0}
                : null));
        const record = {...payload};
        delete record.apps;
        record.checked_at_unix = Date.now() / 1000;
        const touchedOutput = commit.operations > 0 && [...result.changes.keys()].some(
            path => underRoot(path, this.themeDir) || underRoot(path, this.appsDir));
        record.last_updated_at_unix = touchedOutput
            ? record.checked_at_unix : (previousRun.last_updated_at_unix ?? null);
        record.policy_sha256 = this.policySha;
        atomicWrite(lastRunPath, jsonBytes(record), 0o600);
        const appsPath = GLib.build_filenamev([this.stateDir, 'last-run-apps.json']);
        const appsBlob = jsonBytes(payload.apps || []);
        const currentApps = readBytes(appsPath);
        if (!currentApps || shaHex(currentApps) !== shaHex(appsBlob))
            atomicWrite(appsPath, appsBlob, 0o600);
        return payload;
    }

    /**
     * Apply the plan, or dry-run it, fully synchronous.
     *
     * @param {{apply?: boolean}} options
     * @returns {object} payload
     */
    sync(options = {}) {
        const apply = Boolean(options.apply);
        const recovered = apply ? this.recover() : false;
        const result = this.inspect();
        if (!apply) return result.payload;
        return this.#applyPlan(result, recovered);
    }

    /**
     * Apply the plan, or dry-run it, slicing the heavy phases across idle
     * callbacks. Same semantics as sync(); for hosts with a running main loop
     * (gnome-shell, prefs window) so bulk work never blocks the UI thread.
     *
     * @param {{apply?: boolean}} options
     * @param {number} [sliceMs] wall-clock budget per idle callback
     * @returns {Promise<object>} payload
     */
    async syncAsync(options = {}, sliceMs = 20) {
        const apply = Boolean(options.apply);
        const recovered = apply ? this.recover() : false;
        const result = await driveSliced(this.inspectGenerator(), sliceMs);
        if (!apply) return result.payload;
        return this.#applyPlan(result, recovered);
    }

    /**
     * Restore every managed file and reset the manifest.
     *
     * @returns {object} summary
     */
    revert() {
        this.recover();
        const expected = new Map();
        for (const path of [
            GLib.build_filenamev([this.stateDir, 'manifest.json']),
            GLib.build_filenamev([this.stateDir, 'baseline.json']),
        ]) {
            this.allowed(path);
            this.rememberBefore(expected, path, readBytes(path));
        }
        const old = this.manifest();
        this.themedir.owned();
        const changes = new Map();
        for (const [target, record] of Object.entries(old.desktop_overrides || {})) {
            const current = readBytes(target);
            this.rememberBefore(expected, target, current);
            if (current === null) continue;
            if (shaHex(current) === record.output_sha256) {
                changes.set(target, record.original_existed
                    ? GLib.base64_decode(record.original_data) : null);
            } else if ((readDesktopSection(current) || {}).Icon === record.output_icon) {
                changes.set(target, new TextEncoder().encode(
                    rewriteIconLine(current, record.source_icon)));
            } else {
                throw new Error('changed_since_inspection: ' + target);
            }
        }
        for (const item of Object.values(old.items || {})) {
            for (const [p, digest] of Object.entries(item.files || {})) {
                const current = readBytes(p);
                this.rememberBefore(expected, p, current);
                if (current === null) continue;
                if (shaHex(current) === digest) changes.set(p, null);
                else throw new Error('changed_since_inspection: ' + p);
            }
        }
        const manifestPath = GLib.build_filenamev([this.stateDir, 'manifest.json']);
        const empty = {version: MANIFEST_VERSION, base_theme: this.baseTheme,
            items: {}, desktop_overrides: {}};
        this.store.commit(changes, {
            committedLast: [manifestPath, jsonBytes(empty)],
            expectedBefore: expected,
        });
        return {
            ok: true,
            reverted: true,
            restored_theme: this.config.settings ? this.config.settings.iconTheme() : null,
            removed_managed_files: changes.size,
        };
    }
}
