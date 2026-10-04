// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Shell entry (GNOME 45+ ESM). The extension is UI-only: enabling it
// never touches the background maintenance, which lives in systemd user units.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {call, RequestScope} from './lib/backendClient.js';
import {runApplyFlow} from './lib/applyFlow.js';
import {headline, operationExitHint, supportsProfilesAndThemes} from './lib/stateModel.js';
import {Indicator} from './ui/indicator.js';
import {initLanguage} from './lib/i18n.js';

const CONTROL_PATH_PARTS = ['.local', 'libexec', 'icon-normalizer', 'control.py'];
const PANEL_KEY = 'show-panel-indicator';

export default class IconNormalizerExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._requests = new RequestScope();
        this._settings = this.getSettings();
        initLanguage(this._settings, GLib.get_language_names());
        this._controlPath = GLib.build_filenamev([GLib.get_home_dir(), ...CONTROL_PATH_PARTS]);
        this._pending = new Set();
        this._lastRevision = null;
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
        this._themeHandler = this._themeSettings.connect('changed::icon-theme', () => {
            if (this._themeSettings.get_string('icon-theme') === 'DockNormalized') return;
            this._themeDirty = true;
            if (this._themeDebounce) GLib.source_remove(this._themeDebounce);
            this._themeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                this._themeDebounce = 0;
                this._syncTheme();
                return GLib.SOURCE_REMOVE;
            });
        });
        try { this._syncIndicator(); }
        catch (error) { this.disable(); throw error; }
    }

    disable() {
        this._generation++;
        if (this._themeDebounce) { GLib.source_remove(this._themeDebounce); this._themeDebounce = 0; }
        if (this._themeHandler) { this._themeSettings.disconnect(this._themeHandler); this._themeHandler = 0; }
        this._themeSettings = null;
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
        this._lastRevision = null;
        this._controlPath = null;
    }

    _syncIndicator() {
        const show = this._settings?.get_boolean(PANEL_KEY) ?? false;
        if (show && !this._indicator) {
            this._indicator = new Indicator({
                headline,
                actionLabel: operationExitHint,
                onOpenSettings: () => this.openPreferences(),
                requestRefresh: (kind, arg) => this._request(kind, arg),
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
            if (envelope.ok && envelope.result?.revision) {
                this._lastRevision = envelope.result.revision;
            }
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
            const flow = await runApplyFlow(this._controlPath, {activate: null, scope: this._requests});
            if (generation !== this._generation) return;
            if (flow.apply?.ok) {
                this._lastRevision = flow.after?.result?.revision ?? this._lastRevision;
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
        this._pending.add('theme');
        // A ZIP-only upgrade can leave an older companion installed.
        const status = this._lastStatus ??
            (await call(this._controlPath, 'status', {}, this._requests)).result;
        if (generation !== this._generation) return;
        if (!supportsProfilesAndThemes(status)) { this._pending.delete('theme'); return; }
        let envelope;
        do {
            this._themeDirty = false;
            envelope = await call(this._controlPath, 'theme.sync', {}, this._requests);
            if (generation !== this._generation) return;
        } while (this._themeDirty && envelope.ok);
        this._pending.delete('theme');
        if (!envelope.ok) this._indicator?.update(this._lastStatus, envelope);
        this._request('status');
    }
}
