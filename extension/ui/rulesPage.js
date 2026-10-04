// SPDX-License-Identifier: GPL-3.0-or-later
// The existing read-only preview returns effective_policy and saved_revision.
import {t} from '../lib/i18n.js';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {call} from '../lib/backendClient.js';
import {actionLabel} from '../lib/stateModel.js';
import {actionButton, actionGroup, configurePage, noticeRow, toast} from '../lib/uiCommon.js';
import {NamedProfiles} from './namedProfiles.js';

const PRESETS = [
    {label: '标准', detail: '88% · ±2% · 内层 72%', target: 88, deadband: 2, inner: 72},
    {label: '紧凑', detail: '83% · ±2% · 内层 70%', target: 83, deadband: 2, inner: 70},
    {label: '饱满', detail: '92% · ±2% · 内层 75%', target: 92, deadband: 2, inner: 75},
];

export class RulesPage {
    constructor(controlPath, win) {
        this._controlPath = controlPath;
        this._win = win;
        this._loading = true;
        this._dirty = false;
        this._hasPolicy = false;
        this._loadedRevision = null;
        this._syncingPolicy = false;
        this._presetButtons = [];
        this._build();
        this._sensitivity();
    }

    _build() {
        this.page = configurePage(new Adw.PreferencesPage({
            title: t('规则'), icon_name: 'preferences-other-symbolic',
        }));
        this._core = new Adw.PreferencesGroup({
            title: t('视觉参数'), description: t('正在读取已保存的参数…'),
        });
        this._targetSpin = this._spin(t('目标视觉占比'), t('图标主体在画布中所占的比例'), 50, 98, 88);
        this._deadbandSpin = this._spin(t('允许偏差'), t('目标附近的图标保持原样，单位为百分点'), 0, 10, 2);
        this._innerSpin = this._spin(t('裸 Logo 内层占比'), t('补底板时，Logo 在底板中的比例'), 40, 95, 72);
        this._spins = [this._targetSpin, this._deadbandSpin, this._innerSpin];
        for (const spin of this._spins) {
            this._core.add(spin);
            spin.connect('notify::value', () => {
                if (this._syncingPolicy) return;
                this._dirty = true;
                this._core.set_description(t('有未保存的修改，保存后生效。'));
            });
        }
        this.page.add(this._core);

        const presets = new Adw.PreferencesGroup({title: t('常用方案'),
            description: t('选择方案填入参数，再保存生效。')});
        for (const preset of PRESETS) {
            const row = new Adw.ActionRow({title: t(preset.label), subtitle: t(preset.detail)});
            const button = actionButton(t('使用方案'), () => {
                this._resyncFromPolicy({target: preset.target / 100,
                    deadband: preset.deadband / 100, inner: preset.inner / 100});
                this._dirty = true;
                this._explicitPreset = true;
                this._core.set_description(t('已选 {preset}，保存后生效。', {preset: t(preset.label)}));
                this._sensitivity();
                this._notice.hide();
            });
            button.set_hexpand(false);
            row.add_suffix(button);
            this._presetButtons.push(button);
            presets.add(row);
        }
        this.page.add(presets);

        this._profiles = new NamedProfiles(this._controlPath, this._win, {
            getParameters: () => this._parameters(),
            onUse: profile => {
                this._resyncFromPolicy(profile.parameters);
                this._dirty = true; this._explicitPreset = true;
                this._core.set_description(t('已选方案“{name}”，保存后生效。', {name: profile.name}));
                this._sensitivity(); this._notice.hide();
            },
        });
        this.page.add(this._profiles.group);

        this._saveApply = actionButton(t('保存并应用'), () => this._save(true), {primary: true});
        this._saveOnly = actionButton(t('仅保存'), () => this._save(false));
        const actions = actionGroup(t('保存修改'), [this._saveApply, this._saveOnly]);
        this._actionLayout = actions;
        this._notice = noticeRow();
        actions.group.add(this._notice.row);
        this.page.add(actions.group);
    }

    _spin(title, subtitle, lo, hi, value) {
        return new Adw.SpinRow({title, subtitle,
            adjustment: Gtk.Adjustment.new(value, lo, hi, 1, 5, 0)});
    }

    _parameters() {
        return {target: this._targetSpin.get_value() / 100,
            deadband: this._deadbandSpin.get_value() / 100, inner: this._innerSpin.get_value() / 100};
    }

    _sensitivity() {
        const available = !this._loading && !this._saving;
        for (const button of this._presetButtons) button.set_sensitive(available);
        for (const spin of this._spins)
            spin.set_sensitive(Boolean(available && (this._hasPolicy || this._explicitPreset)));
        const save = available && Boolean(this._loadedRevision) && (this._hasPolicy || this._explicitPreset);
        this._saveApply.set_sensitive(Boolean(save));
        this._saveOnly.set_sensitive(Boolean(save));
        this._profiles.setDraftAvailable(Boolean(save));
    }

    async _read(operation, args) {
        let result;
        for (let attempt = 0; attempt < 4; attempt++) {
            result = await call(this._controlPath, operation, args);
            if (result.ok || result.error?.code !== 'BUSY' || attempt === 3) return result;
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                resolve(); return GLib.SOURCE_REMOVE;
            }));
        }
        return result;
    }

    async refresh(scanEnvelope = null, {discard = false} = {}) {
        if (this._refreshPromise) return this._refreshPromise;
        if (this._dirty && !discard) return;
        this._refreshPromise = this._load(scanEnvelope);
        try { return await this._refreshPromise; }
        finally { this._refreshPromise = null; }
    }

    async _load(scanEnvelope) {
        this._loading = true;
        this._sensitivity();
        try {
            const scan = scanEnvelope ?? await this._read('scan', {});
            if (!scan.ok) {
                this._notice.show(actionLabel(scan.error), {error: true,
                    buttonLabel: t('重试'), onClick: () => this.refresh(null, {discard: true})});
                return;
            }
            this._loadedRevision = scan.result.revision;
            const candidates = (scan.result.groups ?? []).filter(g => g.source_sha256 && g.action !== 'excluded');
            for (const group of candidates.slice(0, 3)) {
                const result = await this._read('preview', {
                    icon_id: group.icon_id, source_sha256: group.source_sha256, size: 32,
                });
                if (!result.ok) continue;
                this._loadedRevision = result.result.saved_revision;
                this._hasPolicy = true;
                this._savedPolicy = result.result.effective_policy;
                this._explicitPreset = false;
                this._resyncFromPolicy(result.result.effective_policy);
                this._dirty = false;
                this._notice.hide();
                return;
            }
            this._hasPolicy = false;
            this._core.set_description(t('当前参数尚未读取，选择方案后可保存。'));
            this._notice.show(t('没有可预览的图标素材，请明确选择一个方案。'));
        } finally {
            this._loading = false;
            this._sensitivity();
        }
    }

    _resyncFromPolicy(policy) {
        if (!policy) return;
        this._syncingPolicy = true;
        try {
            if (Number.isFinite(policy.target)) this._targetSpin.set_value(Math.round(policy.target * 100));
            if (Number.isFinite(policy.deadband)) this._deadbandSpin.set_value(Math.round(policy.deadband * 100));
            if (Number.isFinite(policy.inner)) this._innerSpin.set_value(Math.round(policy.inner * 100));
        } finally { this._syncingPolicy = false; }
        this._core.set_description(t('已保存：{target}% 目标 · ±{deadband}% 偏差 · {inner}% 内层', {
            target: Math.round(policy.target * 100), deadband: Math.round(policy.deadband * 100),
            inner: Math.round(policy.inner * 100)}));
    }

    async _save(thenApply) {
        if (this._saving || !this._loadedRevision) return;
        this._saving = true;
        this._sensitivity();
        this._notice.hide();
        try {
            const status = await call(this._controlPath, 'status', {});
            if (!status.ok) { this._notice.show(actionLabel(status.error), {error: true}); return; }
            if (status.result.revision !== this._loadedRevision) {
                this._notice.show(t('策略已被修改，请重新读取后再保存。'), {error: true,
                    buttonLabel: t('重新读取'), onClick: () => this.refresh(null, {discard: true})});
                return;
            }
            const configure = await call(this._controlPath, 'configure', {
                expected_revision: this._loadedRevision,
                patch: this._parameters(),
            });
            if (!configure.ok) { this._notice.show(actionLabel(configure.error), {error: true}); return; }
            this._loadedRevision = configure.result.revision;
            this._savedPolicy = configure.result.effective_policy;
            this._hasPolicy = true;
            this._dirty = false;
            this._resyncFromPolicy(configure.result.effective_policy);
            if (thenApply) {
                const apply = await call(this._controlPath, 'apply', {
                    expected_revision: this._loadedRevision, activate: true,
                });
                if (!apply.ok) { this._notice.show(actionLabel(apply.error), {error: true}); return; }
                this._notice.show(t('策略已保存并应用。'), {success: true});
            } else {
                this._notice.show(t('策略已保存。'), {success: true});
            }
            toast(this._win, thenApply ? t('策略已应用') : t('配置已保存'));
            this.onSaved?.();
        } finally {
            this._saving = false;
            this._sensitivity();
        }
    }
}
