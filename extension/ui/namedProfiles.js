// SPDX-License-Identifier: GPL-3.0-or-later
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import {call} from '../lib/backendClient.js';
import {t} from '../lib/i18n.js';
import {actionLabel, supportsProfilesAndThemes} from '../lib/stateModel.js';
import {actionButton, noticeRow} from '../lib/uiCommon.js';

export class NamedProfiles {
    constructor(controlPath, window, {getParameters, onUse}) {
        this._controlPath = controlPath;
        this._window = window;
        this._getParameters = getParameters;
        this._onUse = onUse;
        this._rows = [];
        this._profiles = [];
        this._draftAvailable = false;
        this.group = new Adw.PreferencesGroup({title: t('自定义方案'),
            description: t('保存多套视觉参数。方案不绑定图标主题，选择后保存生效。')});
        this._saveButton = actionButton(t('保存为自定义方案…'), () => this.openDialog());
        this._saveButton.set_sensitive(false);
        this._saveRow = new Adw.PreferencesRow({child: this._saveButton,
            activatable: false, selectable: false});
        for (const side of ['top', 'bottom', 'start', 'end']) this._saveButton[`set_margin_${side}`](12);
        this._notice = noticeRow();
        this.group.add(this._saveRow);
        this.group.add(this._notice.row);
        window.connect('close-request', () => { this._closed = true; return false; });
        this.ready = this.refresh();
    }

    _hint(error) {
        const reason = error?.details?.reason;
        if (reason === 'PROFILE_NAME_EXISTS') return t('已有同名方案，请换一个名称。');
        if (reason === 'PROFILE_NAME_INVALID') return t('方案名称需要 1–64 个可显示字符。');
        if (reason === 'PROFILE_LIMIT') return t('最多保存 50 个自定义方案。');
        if (error?.code === 'REVISION_CONFLICT') return t('自定义方案已被修改，请重新读取后重试。');
        return actionLabel(error);
    }

    async refresh() {
        const status = await call(this._controlPath, 'status', {});
        if (this._closed) return;
        if (status.ok && !supportsProfilesAndThemes(status.result)) {
            this._notice.show(t('此功能需要后台 3.1.0 或更新版本，请安装完整发行包升级后台。'), {error: true});
            return;
        }
        if (!status.ok) { this._notice.show(this._hint(status.error), {error: true}); return; }
        let response;
        for (let attempt = 0; attempt < 4; attempt++) {
            response = await call(this._controlPath, 'profiles.list', {});
            if (this._closed) return;
            if (response.ok || response.error?.code !== 'BUSY' || attempt === 3) break;
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                resolve(); return GLib.SOURCE_REMOVE;
            }));
            if (this._closed) return;
        }
        if (this._closed) return;
        if (!response.ok) {
            this._notice.show(this._hint(response.error), {error: true,
                buttonLabel: t('重新读取'), onClick: () => this.refresh()});
            return;
        }
        this._accept(response.result);
    }

    _accept(result) {
        this._revision = result.profiles_revision;
        this._profiles = result.profiles;
        this._render();
        this.setDraftAvailable(this._draftAvailable);
    }

    setDraftAvailable(available) {
        this._draftAvailable = available;
        this._saveButton.set_sensitive(!this._busy && Boolean(this._revision) && available);
        for (const row of this._rows) row._useButton?.set_sensitive(!this._busy && available);
    }

    _render() {
        for (const row of this._rows) this.group.remove(row);
        this._rows = [];
        this.group.remove(this._saveRow);
        this.group.remove(this._notice.row);
        if (!this._profiles.length) {
            const row = new Adw.ActionRow({title: t('暂无自定义方案'),
                subtitle: t('调整上方参数后，可保存为自己的方案。')});
            this._rows.push(row); this.group.add(row);
        }
        for (const profile of this._profiles) {
            const p = profile.parameters;
            const row = new Adw.ActionRow({title: profile.name, use_markup: false,
                title_lines: 1, subtitle_lines: 2,
                subtitle: t('{target}% 目标 · ±{deadband}% 偏差 · {inner}% 内层', {
                    target: Math.round(p.target * 100), deadband: Math.round(p.deadband * 100),
                    inner: Math.round(p.inner * 100)})});
            row._normalizerDataProperties = ['title'];
            const use = actionButton(t('使用方案'), () => this._onUse(profile));
            use.set_hexpand(false);
            const edit = new Gtk.Button({icon_name: 'document-edit-symbolic',
                tooltip_text: t('重命名方案'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
            edit.connect('clicked', () => this.openDialog(profile));
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic',
                tooltip_text: t('删除方案'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.connect('clicked', () => this.confirmDelete(profile));
            row.add_suffix(use); row.add_suffix(edit); row.add_suffix(remove);
            use.set_sensitive(!this._busy && this._draftAvailable);
            row._profile = profile; row._useButton = use;
            this._rows.push(row); this.group.add(row);
        }
        this.group.add(this._saveRow); this.group.add(this._notice.row);
    }

    async _mutate(operation, arguments_) {
        if (this._busy || this._closed) return;
        this._busy = true;
        this._saveButton.set_sensitive(false);
        for (const row of this._rows) row.set_sensitive(false);
        try {
            const response = await call(this._controlPath, operation,
                {expected_profiles_revision: this._revision, ...arguments_});
            if (this._closed) return;
            if (!response.ok) {
                this._notice.show(this._hint(response.error), {error: true,
                    buttonLabel: t('重新读取'), onClick: () => this.refresh()});
                return;
            }
            this._accept(response.result);
            this._notice.show(operation === 'profiles.delete' ? t('方案已删除。') : t('方案已保存。'), {success: true});
        } finally {
            this._busy = false;
            if (!this._closed) {
                this.setDraftAvailable(this._draftAvailable);
                for (const row of this._rows) row.set_sensitive(true);
                this.setDraftAvailable(this._draftAvailable);
            }
        }
    }

    openDialog(profile = null) {
        if (this._busy || !this._revision || (!profile && !this._draftAvailable)) return null;
        const parameters = profile?.parameters ?? this._getParameters();
        const dialog = new Adw.MessageDialog({transient_for: this._window, modal: true,
            heading: profile ? t('重命名方案') : t('保存自定义方案'),
            body: profile ? t('重命名保留该方案的参数。') : t('保存当前视觉参数，不改变正在使用的配置。')});
        const entry = new Gtk.Entry({text: profile?.name ?? '', max_length: 64,
            placeholder_text: t('方案名称'), activates_default: true});
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', t('取消'));
        dialog.add_response('save', t('保存'));
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');
        const update = () => dialog.set_response_enabled('save', Boolean(entry.text.trim()));
        entry.connect('changed', update); update();
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'save') return;
            this.lastMutation = this._mutate('profiles.save', {name: entry.text, parameters,
                ...(profile ? {profile_id: profile.id} : {})});
        });
        dialog.present();
        return {dialog, entry};
    }

    confirmDelete(profile) {
        if (this._busy) return null;
        const dialog = new Adw.MessageDialog({transient_for: this._window, modal: true,
            heading: t('删除自定义方案？'),
            body: t('删除“{name}”。当前生效的视觉参数和图标不会改变。', {name: profile.name})});
        dialog.add_response('cancel', t('取消'));
        dialog.add_response('delete', t('删除'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel'); dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete') this.lastMutation = this._mutate('profiles.delete', {profile_id: profile.id});
        });
        dialog.present();
        return dialog;
    }

    retranslate() { if (!this._closed) this._render(); }
}
