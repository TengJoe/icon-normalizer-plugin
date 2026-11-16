// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Shell entry. Rendering runs in the separately installed Python worker.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {call, controlPath, RequestScope} from './shared/backendClient.js';
import {runApplyFlow} from './shared/applyFlow.js';
import {operationExitHint, supportsProfilesAndThemes} from './shared/stateModel.js';
import {Indicator} from './shell/indicator.js';
import {initLanguage} from './shared/i18n.js';
import {syncGtkTheme} from './shell/themeSync.js';

const PANEL_KEY = 'show-panel-indicator';
const THEME_RETRY_DELAY_MS = 500;
const THEME_BUSY_RETRY_LIMIT = 120;

export default class IconNormalizerExtension extends Extension {
    enable() {
        try { this._enable(); }
        catch (error) { this.disable(); throw error; }
    }

    _enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._requests = new RequestScope();
        this._settings = this.getSettings();
        initLanguage(this._settings, GLib.get_language_names());
        this._controlPath = controlPath();
        this._pending = new Set();
        this._lastStatus = null;
        this._indicator = null;
        this._settingsHandler = this._settings.connect(`changed::${PANEL_KEY}`,
            () => this._syncIndicator());
        this._languageHandler = this._settings.connect('changed::ui-language', () => {
            initLanguage(this._settings, GLib.get_language_names());
            this._indicator?.retranslate();
        });
        this._themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._themeDirty = false;
        this._themeSelection = null;
        this._followAppearance = false;

        this._triggerThemeSync = () => {
            this._themeDirty = true;
            if (this._themeDebounce) GLib.source_remove(this._themeDebounce);
            this._themeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._themeDebounce = 0;
                this._syncTheme();
                return GLib.SOURCE_REMOVE;
            });
        };

        const readThemeSelection = () => {
            const selected = this._themeSettings.get_string('icon-theme');
            this._themeSelection = selected === 'DockNormalized' ? null : {name: selected};
        };
        this._themeHandler = this._themeSettings.connect('changed::icon-theme', () => {
            readThemeSelection();
            this._followAppearance = false;
            if (this._themeSelection) this._triggerThemeSync();
        });

        // Reconcile GTK before listening for appearance changes. A startup
        // write to color-scheme must not replace a saved icon source.
        syncGtkTheme(this._themeSettings);
        this._colorSchemeHandler = this._themeSettings.connect('changed::color-scheme', () => {
            syncGtkTheme(this._themeSettings);
            this._followAppearance = true;
            this._triggerThemeSync();
        });

        this._accentColorHandler = this._themeSettings.connect('changed::accent-color', () => {
            syncGtkTheme(this._themeSettings);
            this._followAppearance = true;
            this._triggerThemeSync();
        });

        // Read after connecting so GSettings delivers subsequent key changes.
        readThemeSelection();
        const scheme = this._themeSettings.get_string('color-scheme');
        const accent = this._themeSettings.get_string('accent-color');
        const synced = this._lastSyncedAppearance;
        // Lock/unlock calls disable() then enable(): skip spawning the worker
        // when the overlay is still active and appearance did not change.
        const unchanged = Boolean(synced && !this._themeSelection
            && synced.iconTheme === 'DockNormalized'
            && synced.colorScheme === scheme
            && synced.accent === accent);
        if (!unchanged) {
            if (synced && !this._themeSelection
                    && (synced.colorScheme !== scheme || synced.accent !== accent))
                this._followAppearance = true;
            this._triggerThemeSync();
        }
        this._syncIndicator();
    }

    disable() {
        this._generation++;
        if (this._themeDebounce) { GLib.source_remove(this._themeDebounce); this._themeDebounce = 0; }
        if (this._themeHandler) { this._themeSettings.disconnect(this._themeHandler); this._themeHandler = 0; }
        if (this._colorSchemeHandler) { this._themeSettings.disconnect(this._colorSchemeHandler); this._colorSchemeHandler = 0; }
        if (this._accentColorHandler) { this._themeSettings.disconnect(this._accentColorHandler); this._accentColorHandler = 0; }
        this._themeSettings = null;
        this._triggerThemeSync = null;
        this._requests?.close();
        this._requests = null;
        // Screen lock also calls disable(): only UI objects are torn down —
        // systemd triggers, the theme and any running worker are untouched.
        if (this._settingsHandler) {
            this._settings.disconnect(this._settingsHandler);
            this._settingsHandler = 0;
        }
        if (this._languageHandler) {
            this._settings.disconnect(this._languageHandler);
            this._languageHandler = 0;
        }
        this._settings = null;
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._pending?.clear();
        this._lastStatus = null;
        this._controlPath = null;
    }

    _syncIndicator() {
        const show = this._settings?.get_boolean(PANEL_KEY) ?? false;
        if (show && !this._indicator) {
            this._indicator = new Indicator({
                actionLabel: operationExitHint,
                onOpenSettings: () => this.openPreferences(),
                requestRefresh: (kind, arg) => this._request(kind, arg),
                settings: this._settings,
            });
            this._request('status');
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _request(kind, arg) {
        if (!this._indicator || this._pending.has(kind)) return;
        // 'apply' delegates to the shared flow BEFORE registering as pending so
        // rapid repeat clicks coalesce into one status→apply→status round.
        if (kind === 'apply') {
            this._requestApply();
            return;
        }
        this._pending.add(kind);
        const generation = this._generation;
        if (kind === 'scan') this._indicator.setBusy(true);
        let operation = 'status';
        let args = {};
        if (kind === 'scan') {
            operation = 'scan';
        } else if (kind === 'automation') {
            operation = 'automation.set';
            args = {enabled: !!arg};
        }
        call(this._controlPath, operation, args, this._requests).then(envelope => {
            if (generation !== this._generation) return;
            this._pending.delete(kind);
            if (operation === 'status') {
                if (envelope.ok) this._lastStatus = envelope.result;
                this._indicator?.update(this._lastStatus ?? null, envelope);
            } else {
                if (kind === 'scan') this._indicator?.setBusy(false);
                if (!envelope.ok) this._indicator?.update(this._lastStatus ?? null, envelope);
                else this._request('status');
            }
            if (envelope.error?.code === 'RECOVERY_REQUIRED') {
                // A pending journal exists; an apply run repairs it.
                this._requestApply();
            }
        }).catch(err => {
            if (generation !== this._generation) return;
            logError(err, 'icon-normalizer: panel request failed');
            this._pending.delete(kind);
            if (kind === 'scan') this._indicator?.setBusy(false);
        });
    }

    async _requestApply() {
        if (this._pending.has('apply')) return;
        this._pending.add('apply');
        this._indicator?.setBusy(true);
        const generation = this._generation;
        try {
            const flow = await runApplyFlow(this._controlPath, {
                activate: null,
                scope: this._requests,
            });
            if (generation !== this._generation) return;
            if (flow.apply?.ok) {
                this._indicator?.update(flow.after?.result ?? null, flow.after);
            } else {
                const envelope = flow.apply ?? flow.status;
                this._indicator?.update(null, envelope);
            }
        } catch (err) {
            if (generation !== this._generation) return;
            logError(err, 'icon-normalizer: apply flow failed');
        } finally {
            if (generation === this._generation) {
                this._pending.delete('apply');
                this._indicator?.setBusy(false);
                this._request('status');
            }
        }
    }

    async _syncTheme() {
        if (!this._requests || this._pending.has('theme')) return;
        const generation = this._generation;
        const scope = this._requests;
        this._pending.add('theme');
        // A ZIP-only upgrade can leave an older companion installed.
        const status = this._lastStatus ??
            (await call(this._controlPath, 'status', {}, scope)).result;
        if (generation !== this._generation) return;
        if (!supportsProfilesAndThemes(status)) {
            this._themeSelection = null;
            this._pending.delete('theme');
            return;
        }
        let envelope;
        let busyRetries = 0;
        while (true) {
            this._themeDirty = false;
            const selection = this._themeSelection;
            const args = status.guarded_theme_sync ? {
                expected_icon_theme: selection?.name ?? 'DockNormalized',
                follow_system_variant: this._followAppearance,
            } : {};
            envelope = await call(this._controlPath, 'theme.sync', args, scope);
            if (generation !== this._generation) return;
            if (envelope.error?.code === 'BUSY' && busyRetries < THEME_BUSY_RETRY_LIMIT) {
                busyRetries++;
                if (!await scope.delay(THEME_RETRY_DELAY_MS)) return;
                continue;
            }
            if (selection === this._themeSelection) this._themeSelection = null;
            if (!this._themeDirty) {
                this._followAppearance = false;
                break;
            }
            busyRetries = 0;
        }
        if (envelope.ok && envelope.result?.theme_activation !== 'superseded' && this._themeSettings) {
            this._lastSyncedAppearance = {
                iconTheme: this._themeSettings.get_string('icon-theme'),
                colorScheme: this._themeSettings.get_string('color-scheme'),
                accent: this._themeSettings.get_string('accent-color'),
            };
        }
        this._pending.delete('theme');
        if (!envelope.ok) this._indicator?.update(this._lastStatus, envelope);
        this._request('status');
    }
}
