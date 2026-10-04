// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {t, formatAppliedTime} from '../lib/i18n.js';
import {automaticLabel} from '../lib/stateModel.js';

const STATE_DIR_PARTS = ['.local', 'state', 'icon-normalizer'];

export class Indicator {
    constructor({actionLabel, onOpenSettings, requestRefresh}) {
        this._actionLabelFn = actionLabel;
        this._onOpenSettings = onOpenSettings;
        this._requestRefresh = requestRefresh;
        this._debounceId = 0;
        this._syncingAutomatic = false;
        this._indicator = new PanelMenu.Button(0.0, t('图标统一'));
        const file = Gio.File.new_for_uri(import.meta.url).get_parent()
            .resolve_relative_path('../icons/icon-normalizer-symbolic.svg');
        this._gicon = new Gio.FileIcon({file});
        this._icon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this._indicator.add_child(this._icon);
        try {
            this._buildMenu();
            Main.panel.addToStatusArea('icon-normalizer', this._indicator);
            this._watchStateDir();
            this.retranslate();
        } catch (err) {
            this.destroy();
            throw err;
        }
    }

    get menu() { return this._indicator.menu; }

    _label(text, styleClass = '') {
        const label = new St.Label({text, style_class: styleClass, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        return label;
    }

    _buildMenu() {
        this.menu.actor.add_style_class_name('normalizer-menu');
        const summary = new PopupMenu.PopupBaseMenuItem({reactive: true, activate: false,
            hover: false, can_focus: false,
            style_class: 'normalizer-summary'});
        summary.remove_style_class_name('popup-inactive-menu-item');
        const vertical = St.BoxLayout.list_properties().some(p => p.name === 'orientation')
            ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
        const body = new St.BoxLayout({...vertical, x_expand: true,
            style_class: 'normalizer-summary-body'});
        const header = new St.BoxLayout({style_class: 'normalizer-summary-header'});
        header.add_child(new St.Icon({gicon: this._gicon, icon_size: 20}));
        this._nameLabel = this._label('');
        this._nameLabel.add_style_class_name('normalizer-name');
        header.add_child(this._nameLabel);
        this._stateLabel = this._label('', 'normalizer-state');
        this._stateLabel.x_expand = false;
        header.add_child(this._stateLabel);
        body.add_child(header);
        this._detailLabel = this._label('', 'normalizer-detail');
        body.add_child(this._detailLabel);
        const addMetadata = () => {
            const row = new St.BoxLayout({style_class: 'normalizer-metadata'});
            const key = this._label('', 'normalizer-meta-key');
            key.x_expand = false;
            const value = this._label('', 'normalizer-meta-value');
            value.clutter_text.set_line_alignment(Pango.Alignment.RIGHT);
            row.add_child(key); row.add_child(value); body.add_child(row);
            return {key, value};
        };
        this._theme = addMetadata();
        this._applied = addMetadata();
        summary.add_child(body);
        this.menu.addMenuItem(summary);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._checkItem = new PopupMenu.PopupImageMenuItem('', 'view-refresh-symbolic');
        this._checkItem.connect('activate', () => this._requestRefresh('scan'));
        this._applyItem = new PopupMenu.PopupImageMenuItem('', 'emblem-ok-symbolic');
        this._applyItem.connect('activate', () => this._requestRefresh('apply'));
        this.menu.addMenuItem(this._checkItem);
        this.menu.addMenuItem(this._applyItem);
        this._autoItem = new PopupMenu.PopupSwitchMenuItem('', false);
        this._autoItem.connect('toggled', (_item, state) => {
            if (!this._syncingAutomatic) this._requestRefresh('automation', state);
        });
        this.menu.addMenuItem(this._autoItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._settingsItem = new PopupMenu.PopupImageMenuItem('', 'preferences-system-symbolic');
        this._settingsItem.connect('activate', () => this._onOpenSettings());
        this.menu.addMenuItem(this._settingsItem);
    }

    retranslate() {
        this._indicator.accessible_name = t('图标统一');
        this._nameLabel.set_text(t('图标统一'));
        this._theme.key.set_text(t('主题'));
        this._applied.key.set_text(t('最近应用'));
        this._checkItem.label.set_text(t('立即检查'));
        this._applyItem.label.set_text(t('立即应用'));
        this._autoItem.label.set_text(t('自动维护'));
        this._settingsItem.label.set_text(t('设置…'));
        this.update(this._status, this._envelope);
    }

    setBusy(busy) {
        this._localBusy = busy;
        this.update(this._status, this._envelope);
    }

    update(status, envelope) {
        this._status = status;
        this._envelope = envelope;
        const busy = this._localBusy || status?.busy === true;
        const failed = envelope && !envelope.ok;
        let state = t('后台状态读取中…');
        let detail = '';
        if (failed) {
            state = t('操作失败');
            detail = this._actionLabelFn(envelope);
        } else if (status) {
            state = status.installed === false ? t('后台未安装')
                : busy ? t('正在处理图标…') : status.recovery_pending ? t('有待恢复事务')
                : status.stale ? t('有待处理的图标') : status.overlay_in_use === false
                    ? t('未启用图标主题') : status.overlay_in_use === true
                        ? t('图标已统一') : t('后台状态未知');
            detail = t('{count} 个图标 · 自动维护{automatic}', {
                count: status.summary?.managed_icons ?? '—', automatic: automaticLabel(status)});
            if (status.automatic === 'partial') detail = t('部分触发器未开启');
            if (status.automatic === 'unknown') detail = t('触发器状态未知');
        }
        this._stateLabel.set_text(state);
        this._stateLabel.set_style_class_name('normalizer-state' +
            (failed || status?.installed === false || status?.recovery_pending || status?.stale
                ? ' normalizer-state-warning' : ''));
        this._detailLabel.set_text(detail);
        this._theme.value.set_text(status?.active_theme ?? '—');
        this._applied.value.set_text(formatAppliedTime(status?.last_apply_at));
        this._syncingAutomatic = true;
        try { this._autoItem.setToggleState(status?.automatic === 'on'); }
        finally { this._syncingAutomatic = false; }
        this._checkItem.setSensitive(!busy && status?.installed !== false);
        this._applyItem.setSensitive(!busy && status?.installed !== false);
    }

    _watchStateDir() {
        try {
            const dir = Gio.File.new_for_path(GLib.build_filenamev([
                GLib.get_home_dir(), ...STATE_DIR_PARTS]));
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => {
                if (this._debounceId) GLib.source_remove(this._debounceId);
                this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    this._debounceId = 0; this._requestRefresh('status');
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (err) { logError(err, 'icon-normalizer: state dir monitor unavailable'); }
    }

    destroy() {
        if (this._debounceId) { GLib.source_remove(this._debounceId); this._debounceId = 0; }
        if (this._monitor) {
            if (this._monitorId) this._monitor.disconnect(this._monitorId);
            this._monitorId = 0; this._monitor.cancel(); this._monitor = null;
        }
        this._indicator?.destroy(); this._indicator = null;
    }
}
