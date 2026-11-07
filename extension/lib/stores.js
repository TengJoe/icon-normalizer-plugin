// Persisted configuration stores that the in-process control surface owns:
// policy patches, named profiles and the theme-follow flag.
//
// Semantics mirror backend/icon_normalizer/{policy,profiles,theme_follow}.py so
// the pure-GJS path and the Python worker stay interchangeable.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {atomicWrite, readBytes, shaHex} from './engine/transaction.js';

/** Numeric bounds enforced on every policy value (policy.py RANGES). */
export const RANGES = {target: [0.50, 0.98], deadband: [0.0, 0.10], inner: [0.40, 0.95]};

/** The three values a named profile stores. */
export const VISUAL_KEYS = ['target', 'deadband', 'inner'];

/** Upper bound on saved profiles. */
export const MAX_PROFILES = 50;

/** Error carrying a PROTOCOL.md §6 code. */
export class StoreError extends Error {
    /**
     * @param {string} code protocol error code
     * @param {string} message human-readable explanation
     * @param {object} [details] extra envelope details
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = "StoreError";
        this.code = code;
        this.retryable = code === "REVISION_CONFLICT";
        this.details = details;
    }
}

/** Read JSON from a path, or null when absent/invalid. */
function readJson(path) {
    const bytes = readBytes(path);
    if (!bytes) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

/** Write JSON with a compressed-free stable layout. */
function writeJson(path, value, mode = 0o600) {
    atomicWrite(path, new TextEncoder().encode(JSON.stringify(value, null, 2)), mode);
}

/**
 * Validate the three visual policy values the way policy.py does.
 *
 * @param {number} target coverage target
 * @param {number} deadband symmetric tolerance
 * @param {number} inner inner glyph coverage
 */
export function validatePolicyValues(target, deadband, inner) {
    const values = {target, deadband, inner};
    for (const key of VISUAL_KEYS) {
        const [lo, hi] = RANGES[key];
        const value = values[key];
        if (typeof value !== "number" || !Number.isFinite(value))
            throw new StoreError("INVALID_CONFIG", "policy." + key + " must be a finite number");
        if (value < lo || value > hi)
            throw new StoreError("INVALID_CONFIG",
                "policy." + key + " out of range [" + lo + "," + hi + "]");
    }
    // The dead band must stay inside the canvas, or a target would be unreachable.
    if (!(0 < target - deadband && target + deadband <= 1))
        throw new StoreError("INVALID_CONFIG",
            "cross-field rule violated: 0 < target-deadband and target+deadband <= 1");
}

/**
 * Merge a protocol patch onto the current policy and validate the result.
 *
 * Only the three visual keys may be patched: sizes and base_theme come from
 * the engine configuration and the theme picker respectively.
 *
 * @param {object} current current policy
 * @param {object} patch protocol patch
 * @returns {object} updated policy
 */
export function applyPatch(current, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new StoreError("INVALID_REQUEST", "configure requires a patch object");
    const unknown = Object.keys(patch).filter(key => !VISUAL_KEYS.includes(key));
    if (unknown.length)
        throw new StoreError("INVALID_REQUEST",
            "configure patch accepts target, deadband and inner only");
    const next = {
        target: patch.target === undefined ? current.target : Number(patch.target),
        deadband: patch.deadband === undefined ? current.deadband : Number(patch.deadband),
        inner: patch.inner === undefined ? current.inner : Number(patch.inner),
        sizes: current.sizes,
        base_theme: current.base_theme,
    };
    validatePolicyValues(next.target, next.deadband, next.inner);
    return next;
}

/**
 * Named profile catalogue backed by profiles.json.
 *
 * Writes are guarded by an explicit expected revision, mirroring the OCC the
 * Python store implements, so two windows cannot silently overwrite each other.
 */
export class ProfilesStore {
    /** @param {string} stateDir icon-normalizer state directory */
    constructor(stateDir) {
        this.path = GLib.build_filenamev([stateDir, 'profiles.json']);
    }

    /** @returns {object} stored document with a stable shape */
    document() {
        const raw = readJson(this.path);
        const profiles = raw && Array.isArray(raw.profiles) ? raw.profiles : [];
        return {schema_version: 1, profiles};
    }

    /** @returns {object} catalogue plus its revision */
    catalog() {
        const document = this.document();
        return {
            profiles_revision: shaHex(JSON.stringify(document)),
            profiles: document.profiles,
        };
    }

    /**
     * @param {object} args protocol arguments
     * @returns {object} new catalogue plus the saved profile
     */
    save(args) {
        const current = this.catalog();
        this.#requireRevision(args);
        const profiles = [...current.profiles];
        const name = String(args.name === undefined ? "" : args.name).trim();
        if (!name || name.length > 60)
            throw new StoreError("INVALID_REQUEST", "profile name must be 1-60 characters");
        const parameters = this.#parameters(args.parameters);
        let identifier = args.profile_id || null;
        if (identifier !== null && !profiles.some(p => p.id === identifier))
            throw new StoreError("NOT_FOUND", "profile no longer exists");
        const clash = profiles.some(p => p.name.toLowerCase() === name.toLowerCase()
            && p.id !== identifier);
        if (clash)
            throw new StoreError("INVALID_CONFIG", "a profile with this name already exists",
                {reason: "PROFILE_NAME_EXISTS"});
        if (identifier === null && profiles.length >= MAX_PROFILES)
            throw new StoreError("INVALID_CONFIG", "at most " + MAX_PROFILES
                + " profiles are supported", {reason: "PROFILE_LIMIT"});
        identifier = identifier || GLib.uuid_string_random();
        const profile = {id: identifier, name, parameters};
        const index = profiles.findIndex(p => p.id === identifier);
        if (index >= 0) profiles[index] = profile;
        else profiles.push(profile);
        writeJson(this.path, {schema_version: 1, profiles});
        return {...this.catalog(), profile};
    }

    /**
     * @param {object} args protocol arguments
     * @returns {object} new catalogue
     */
    delete(args) {
        this.#requireRevision(args);
        const profiles = this.document().profiles.filter(p => p.id !== args.profile_id);
        writeJson(this.path, {schema_version: 1, profiles});
        return this.catalog();
    }

    /** Reject a stale catalogue revision. */
    #requireRevision(args) {
        const expected = args.expected_profiles_revision;
        if (expected === undefined || expected === null) return;
        const current = this.catalog().profiles_revision;
        if (expected !== current)
            throw new StoreError("REVISION_CONFLICT",
                "profiles changed; refresh before saving",
                {current_profiles_revision: current});
    }

    /** Validate the stored parameter triple. */
    #parameters(value) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new StoreError("INVALID_REQUEST",
                "profile parameters require target, deadband and inner only");
        const keys = Object.keys(value).sort().join(",");
        if (keys !== [...VISUAL_KEYS].sort().join(","))
            throw new StoreError("INVALID_REQUEST",
                "profile parameters require target, deadband and inner only");
        const result = {};
        for (const key of VISUAL_KEYS) {
            const raw = value[key];
            if (typeof raw !== "number" || !Number.isFinite(raw))
                throw new StoreError("INVALID_REQUEST",
                    "profile parameters must be finite numbers");
            result[key] = raw;
        }
        validatePolicyValues(result.target, result.deadband, result.inner);
        return result;
    }
}

/**
 * Theme-follow flag backed by theme-follow.json; absent means enabled.
 */
export class ThemeFollowStore {
    /** @param {string} stateDir icon-normalizer state directory */
    constructor(stateDir) {
        this.path = GLib.build_filenamev([stateDir, 'theme-follow.json']);
    }

    /** @returns {boolean} */
    enabled() {
        const raw = readJson(this.path);
        if (!raw || typeof raw.enabled !== "boolean") return true;
        return raw.enabled;
    }

    /** @param {boolean} value */
    setEnabled(value) {
        writeJson(this.path, {schema_version: 1, enabled: Boolean(value)});
    }
}
