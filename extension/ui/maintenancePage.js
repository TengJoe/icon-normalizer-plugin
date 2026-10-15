// SPDX-License-Identifier: GPL-3.0-or-later
// Maintenance page: dashboard of background health, one-tap apply/revert
// channels and the automation/panel switches (signal-guarded).
import {t, getLanguage, formatAppliedTime, LANGUAGE_CHOICES} from '../lib/i18n.js';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {call} from '../lib/backendClient.js';
import {runApplyFlow} from '../lib/applyFlow.js';
import {actionLabel, supportsProfilesAndThemes, automaticLabel, maintenanceHealth} from '../lib/stateModel.js';
import {actionButton, actionGroup, bindSwitch, configurePage, noticeRow, statusBadge, toast} from '../lib/uiCommon.js';
import {AboutSupport} from './aboutSupport.js';

export class MaintenancePage {
    constructor(controlPath, win, settings) {
        this._controlPath = controlPath;
        this._win = win;
        this._settings = settings;
        this._build();
    }

    _build() {
        this.page = configurePage(new Adw.PreferencesPage({
            title: t('维护'),
            icon_name: 'system-software-update-symbolic',
        }));

        // ---- dashboard -------------------------------------------------
        const dashboard = new Adw.PreferencesGroup({title: t('运行状态')});
        this._rowVersion = this._dashboardRow(t('后端版本'), '—', 'badge-keep', '_badgeVersion');
        this._rowTheme = this._dashboardRow(t('图标主题'), '', 'badge-keep', '_badgeTheme');
        this._rowTheme._normalizerDataProperties = ['subtitle'];
        this._rowManaged = this._dashboardRow(t('已管理图标'), '—', 'badge-keep', '_badgeManaged');
        this._rowAuto = this._dashboardRow(t('自动维护'), t('未知'), 'badge-keep', '_badgeAuto');
        this._rowRev = new Adw.ActionRow({title: t('策略版本')});
        this._lblRev = new Gtk.Label({label: '—', valign: Gtk.Align.CENTER,
            ellipsize: 3, max_width_chars: 16, css_classes: ['mono-stat', 'dimmed']});
        this._rowRev.add_suffix(this._lblRev);
        dashboard.add(this._rowVersion);
        dashboard.add(this._rowTheme);
        dashboard.add(this._rowManaged);
        dashboard.add(this._rowAuto);
        this._rowHealth = this._dashboardRow(t('后台健康'), t('状态未知'), 'badge-keep', '_badgeHealth');
        this._rowHealth._normalizerDataProperties = ['subtitle'];
        this._healthDetails = actionButton(t('查看详情'), () => this._showHealthDetails());
        dashboard.add(this._rowHealth);
        this._rowHealthDetails = new Adw.ActionRow({title: t('故障详情'),
            subtitle: t('查看冲突文件与首次发生时间')});
        this._rowHealthDetails.add_suffix(this._healthDetails);
        dashboard.add(this._rowHealthDetails);
        this._rowChecked = new Adw.ActionRow({title: t('最近检查成功')});
        this._rowUpdated = new Adw.ActionRow({title: t('最近更新')});
        this._rowChecked._normalizerDataProperties = ['subtitle'];
        this._rowUpdated._normalizerDataProperties = ['subtitle'];
        dashboard.add(this._rowChecked);
        dashboard.add(this._rowUpdated);
        dashboard.add(this._rowRev);
        this.page.add(dashboard);

        // ---- actions ---------------------------------------------------
        this._btnScan = actionButton(t('立即检查'), () => this._scan());
        this._btnApply = actionButton(t('立即应用'), () => this._apply(false));
        this._btnActivate = actionButton(t('应用并激活'), () => this._apply(true), {primary: true});
        const actions = actionGroup(t('图标维护'), [this._btnScan, this._btnApply, this._btnActivate],
            t('检查当前图标，或将归一化效果应用到桌面。'));
        this._actionLayout = actions;
        this._opNotice = noticeRow();
        actions.group.add(this._opNotice.row);
        this.page.add(actions.group);

        // ---- integration switches --------------------------------------
        const integration = new Adw.PreferencesGroup({title: t('自动维护与显示')});
        this._autoRow = new Adw.SwitchRow({title: t('自动维护图标'),
            subtitle: t('新安装或更新应用后自动处理图标。')});
        this._setAuto = bindSwitch(this._autoRow, active => this._setAutomation(active));
        integration.add(this._autoRow);
        this._followRow = new Adw.SwitchRow({title: t('跟随图标主题'),
            subtitle: t('切换到新图标主题时保留参数并重新归一化；需要开启自动维护。')});
        this._setFollow = bindSwitch(this._followRow, async enabled => {
            this._followRow.set_sensitive(false);
            const response = await call(this._controlPath, 'theme.follow', {enabled});
            if (!response.ok) this._showOpBanner(actionLabel(response.error));
            await this.refresh();
        });
        integration.add(this._followRow);

        this._panelRow = new Adw.SwitchRow({title: t('显示顶栏按钮'),
            subtitle: t('在顶栏快速查看状态和执行操作。')});
        this._setPanel = bindSwitch(this._panelRow, active => {
            this._settings.set_boolean('show-panel-indicator', active);
            toast(this._win, active ? t('顶栏指示器已开启') : t('顶栏指示器已关闭'));
        });
        this._setPanel(this._settings.get_boolean('show-panel-indicator'));
        integration.add(this._panelRow);
        this._languageRow = new Adw.ComboRow({title: t('界面语言'),
            use_subtitle: true,
            tooltip_text: t('切换顶栏与设置界面的语言。'),
            model: Gtk.StringList.new([t('跟随系统'), '简体中文', 'English'])});
        this._languageRow.set_selected(Math.max(0, LANGUAGE_CHOICES.indexOf(
            this._settings.get_string('ui-language'))));
        this._languageRow.connect('notify::selected', () => {
            if (this._syncingLanguage) return;
            const choice = LANGUAGE_CHOICES[this._languageRow.get_selected()];
            if (choice && choice !== this._settings.get_string('ui-language'))
                this._settings.set_string('ui-language', choice);
        });
        integration.add(this._languageRow);
        this.page.add(integration);

        // ---- danger zone ------------------------------------------------
        const danger = new Adw.PreferencesGroup({title: t('恢复原样')});
        const revertRow = new Adw.ActionRow({
            title: t('还原桌面图标'),
            subtitle: t('移除生成的图标，恢复原始图标和主题。'),
        });
        this._btnRevert = actionButton(t('还原'), () => this._confirmRevert(), {destructive: true});
        this._btnRevert.set_hexpand(false);
        revertRow.add_suffix(this._btnRevert);
        danger.add(revertRow);
        this.page.add(danger);
        this._about = new AboutSupport(this._win);
        this.page.add(this._about.group);
    }

    retranslate() {
        this._syncingLanguage = true;
        try {
            this._languageRow.set_model(Gtk.StringList.new([t('跟随系统'), '简体中文', 'English']));
            this._languageRow.set_selected(Math.max(0, LANGUAGE_CHOICES.indexOf(
                this._settings.get_string('ui-language'))));
        } finally { this._syncingLanguage = false; }
        this._about.retranslate();
        this.refresh();
    }

    _dashboardRow(title, initial, cssClass, badgeField) {
        const row = new Adw.ActionRow({title});
        const badge = statusBadge(initial, cssClass);
        row.add_suffix(badge);
        this[badgeField] = badge;
        return row;
    }

    async refresh() {
        const envelope = await call(this._controlPath, 'status', {});
        if (!envelope.ok) {
            this._showOpBanner(actionLabel(envelope.error));
            return;
        }
        const s = envelope.result;
        this._lastHealthError = s.last_error;
        const health = maintenanceHealth(s);
        this._badgeHealth.set_text(health.badge);
        this._badgeHealth.set_tooltip_text(health.label);
        this._badgeHealth.set_css_classes(['badge-pill', health.warning ? 'badge-warn' : 'badge-keep']);
        this._rowHealth.set_subtitle(health.detail || '');
        this._healthDetails.set_visible(Boolean(s.last_error));
        this._rowHealthDetails.set_visible(Boolean(s.last_error));
        this._rowChecked.set_subtitle(s.last_check_at ? formatAppliedTime(s.last_check_at) : '—');
        this._rowUpdated.set_subtitle(s.last_apply_at ? formatAppliedTime(s.last_apply_at) : t('暂无更新记录'));
        // Badge widths stay uniform: short words only; details live in subtitles.
        this._rowTheme.set_subtitle(s.active_theme ?? t('未知主题'));
        this._rowTheme.set_tooltip_text(t('图标素材来源：{theme}', {theme: s.source_theme ?? t('未知主题')}));
        this._badgeVersion.set_text(String(s.backend_version ?? '—'));
        this._badgeTheme.set_text(s.overlay_in_use === true ? t('生效中')
            : s.overlay_in_use === false ? t('未生效') : t('未知'));
        this._badgeTheme.set_css_classes(['badge-pill',
            s.overlay_in_use === true ? 'badge-active' : 'badge-keep']);
        const managed = s.summary?.managed_icons;
        this._badgeManaged.set_text(Number.isFinite(managed) ? t('{count} 个', {count: managed}) : '—');
        this._badgeAuto.set_text(automaticLabel(s));
        this._badgeAuto.set_css_classes(['badge-pill',
            s.automatic === 'on' ? 'badge-active' :
                s.automatic === 'off' ? 'badge-keep' : 'badge-warn']);
        this._lblRev.set_text(s.revision ? `${String(s.revision).slice(0, 16)}…` : '—');
        this._lblRev.set_tooltip_text(s.revision ?? '');
        // programmatic sync — the guard keeps the handler from firing writes
        this._setAuto(s.automatic === 'on');
        this._setFollow(s.theme_follow === true);
        this._followRow.set_sensitive(typeof s.theme_follow === 'boolean');
        this._followRow.set_tooltip_text(typeof s.theme_follow === 'boolean' ? null :
            supportsProfilesAndThemes(s) ? t('状态未知') : t('此功能需要后台 3.1.0 或更新版本，请安装完整发行包升级后台。'));
        if (s.automatic === 'partial' || s.automatic === 'unknown') {
            this._showOpBanner(
                s.automatic === 'partial' ? t('部分触发器未开启；点击自动维护开关可修复')
                    : t('触发器状态未知：systemd 用户实例不可用？'));
        }
    }

    _showOpBanner(text) {
        this._opNotice.show(text);
    }

    _showHealthDetails() {
        if (!this._lastHealthError) return null;
        const error = this._lastHealthError;
        const lines = [actionLabel(error), `Code: ${error.code}`];
        const format = seconds => new Intl.DateTimeFormat(getLanguage() === 'zh' ? 'zh-CN' : 'en', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
            minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(seconds * 1000));
        if (Number.isFinite(error.first_seen_unix)) lines.push(t('首次发现：{time}', {time: format(error.first_seen_unix)}));
        if (Number.isFinite(error.last_seen_unix)) lines.push(t('最近发现：{time}', {time: format(error.last_seen_unix)}));
        if (error.count) lines.push(t('连续失败 {count} 次', {count: error.count}));
        if (error.details) lines.push(JSON.stringify(error.details, null, 2));
        const text = new Gtk.TextView({editable: false, cursor_visible: false,
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR});
        text.get_buffer().set_text(lines.join('\n\n'), -1);
        const scroll = new Gtk.ScrolledWindow({min_content_height: 220, hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER, child: text});
        const dialog = new Adw.MessageDialog({transient_for: this._win,
            destroy_with_parent: true, heading: t('维护故障详情'), extra_child: scroll});
        dialog.add_response('close', t('关闭'));
        dialog.set_close_response('close');
        dialog.present();
        return dialog;
    }

    async _scan() {
        this._busy(true);
        try {
            const envelope = await call(this._controlPath, 'scan', {});
            if (!envelope.ok) {
                this._showOpBanner(actionLabel(envelope.error));
                return;
            }
            const summary = envelope.result.summary ?? {};
            toast(this._win,
                t('检查完成：{candidates} 候选 · {managed} 托管 · {changes} 计划变更', {
                    candidates: summary.candidate_icons ?? '?', managed: summary.managed_icons ?? '?',
                    changes: summary.planned_file_changes ?? 0}));
            await this.refresh();
        } finally {
            this._busy(false);
        }
    }

    async _apply(activate) {
        this._busy(true);
        try {
            const flow = await runApplyFlow(this._controlPath, {activate});
            if (!flow.apply?.ok) {
                this._showOpBanner(flow.hint || actionLabel(flow.apply?.error));
                return;
            }
            const ops = flow.apply.result.file_operations ?? 0;
            const recovered = flow.apply.result.recovered_transaction
                ? t('（已恢复中断事务）') : '';
            this._showOpBanner(t('应用完成：{operations} 项文件操作', {operations: ops}) + recovered +
                (flow.activate ? t('，主题已激活') : ''));
            await this.refresh();
        } finally {
            this._busy(false);
        }
    }

    async _setAutomation(enabled) {
        const envelope = await call(this._controlPath, 'automation.set', {enabled});
        if (!envelope.ok) {
            this._showOpBanner(actionLabel(envelope.error));
        } else {
            toast(this._win, enabled ? t('自动维护已开启') : t('自动维护已关闭'));
        }
        // Re-sync from the server on both paths (failure path restores the switch).
        await this.refresh();
    }

    _confirmRevert() {
        const confirm = new Adw.MessageDialog({
            heading: t('完全还原桌面图标？'),
            body: t('将移除全部 DockNormalized 托管图标，恢复原始启动器与主题设置。此操作不依赖回收站，但可随时重新应用。'),
            modal: true,
            transient_for: this._win,
        });
        confirm.add_response('cancel', t('取消'));
        confirm.add_response('revert', t('恢复原样'));
        confirm.set_response_appearance('revert', Adw.ResponseAppearance.DESTRUCTIVE);
        confirm.connect('response', (_dialog, response) => {
            if (response === 'revert') this._revert();
        });
        confirm.present();
        return confirm;
    }

    async _revert() {
        this._busy(true);
        try {
            const envelope = await call(this._controlPath, 'revert', {});
            if (!envelope.ok) {
                this._showOpBanner(actionLabel(envelope.error));
                return;
            }
            this._showOpBanner(
                t('已还原：移除 {count} 个托管文件，主题恢复为 {theme}', {
                    count: envelope.result.removed_managed_files ?? 0,
                    theme: envelope.result.restored_theme ?? t('原主题')}));
            await this.refresh();
        } finally {
            this._busy(false);
        }
    }

    _busy(busy) {
        this._btnScan.set_sensitive(!busy);
        this._btnApply.set_sensitive(!busy);
        this._btnActivate.set_sensitive(!busy);
        this._btnRevert.set_sensitive(!busy);
    }
}
