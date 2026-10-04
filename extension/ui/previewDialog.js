// SPDX-License-Identifier: GPL-3.0-or-later
// Live before/after comparison dialog: multi-size renders (32..256), light/dark
// stage, detailed metrics and the per-icon skip rule — Adw.Dialog on GNOME 46+,
// Adw.Window fallback on GNOME 45.
import {t} from '../lib/i18n.js';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {call} from '../lib/backendClient.js';
import {CLASSIFICATION_LABELS, actionLabel} from '../lib/stateModel.js';
import {
    PREVIEW_SIZES,
    actionButton,
    adaptiveBox,
    pictureFromBase64,
    presentDialog,
    toast,
} from '../lib/uiCommon.js';

export function openPreview(parent, group, {controlPath, settings, onRuleChanged}) {
    if (!group.source_sha256) {
        toast(parent, t('该图标组缺少源素材指纹，无法预览'));
        return;
    }

    const dialogState = {
        size: PREVIEW_SIZES.includes(settings.get_int('preview-size'))
            ? settings.get_int('preview-size') : 48,
        background: settings.get_string('preview-background') === 'dark' ? 'dark' : 'light',
    };
    let syncingControls = false;
    let previewGeneration = 0;

    // ------------------------------------------------------------- layout
    const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0,
        css_classes: ['normalizer-page']});
    const header = new Adw.HeaderBar();
    root.append(header);

    const scrolled = new Gtk.ScrolledWindow({
        propagate_natural_height: false,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vexpand: true,
    });
    root.append(scrolled);

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 16,
        margin_bottom: 16, margin_start: 16, margin_end: 16});
    scrolled.set_child(content);

    const originalCard = _makeStage(t('原始图标素材'));
    const proposedCard = _makeStage(t('归一化效果'));
    const stages = adaptiveBox([originalCard.box, proposedCard.box], {spacing: 16, below: 540});
    content.append(stages.widget);

    // size selector + background toggle
    const controls = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 6, row_spacing: 6, min_children_per_line: 1,
        max_children_per_line: 6, homogeneous: true,
        css_classes: ['normalizer-filters']});
    const sizeButtons = new Map();
    for (const size of PREVIEW_SIZES) {
        const button = new Gtk.ToggleButton({label: `${size}px`, css_classes: ['normalizer-filter']});
        button.connect('toggled', () => {
            if (syncingControls || !button.active) return;
            dialogState.size = size;
            settings.set_int('preview-size', size);
            for (const [other, otherButton] of sizeButtons) {
                if (other !== size) otherButton.set_active(false);
            }
            fetchPreview();
        });
        sizeButtons.set(size, button);
        controls.insert(button, -1);
    }
    const backgroundButton = new Gtk.ToggleButton({
        icon_name: 'night-light-symbolic',
        tooltip_text: t('深色/浅色底切换'),
        css_classes: ['normalizer-filter'],
    });
    backgroundButton.connect('toggled', () => {
        if (syncingControls) return;
        dialogState.background = backgroundButton.active ? 'dark' : 'light';
        settings.set_string('preview-background', dialogState.background);
        _applyBackground();
    });
    controls.insert(backgroundButton, -1);
    content.append(controls);

    // details
    const details = new Adw.PreferencesGroup({title: t('详细分析数据')});
    const rowClass = new Adw.ActionRow({title: t('分类')});
    const rowAction = new Adw.ActionRow({title: t('处理动作')});
    const rowPath = new Adw.ActionRow({title: t('源素材路径')});
    rowPath._normalizerDataProperties = ['subtitle'];
    rowPath.set_subtitle(group.source_path ?? '—');
    rowPath.set_tooltip_text(group.source_path ?? '—');
    rowPath.set_title_lines(1);
    rowPath.set_subtitle_lines(1);
    details.add(rowClass);
    details.add(rowAction);
    details.add(rowPath);
    content.append(details);

    // action bar: skip toggle + close
    const skipButton = actionButton(t('跳过此图标'), () => toggleSkip(group, () => {}));
    const closeButton = actionButton(t('完成'), () => handle.close(), {primary: true});
    const actionBar = adaptiveBox([skipButton, closeButton]);
    content.append(actionBar.widget);

    rowClass.set_subtitle(t('{classification}（{origin}）', {
        classification: t(CLASSIFICATION_LABELS[group.classification] ?? group.classification ?? '—'),
        origin: group.classification_origin === 'user' ? t('用户指定') :
            group.classification_origin === 'reviewed' ? t('已复核') : t('自动')}));
    rowAction.set_subtitle(actionText(group));

    function actionText(g) {
        switch (g.action) {
            case 'enlarge': return t('放大至目标占比');
            case 'shrink': return t('缩小至目标占比');
            case 'add_plate': return t('补充超椭圆底板');
            case 'keep': return t('死区内，保留原素材');
            case 'skipped': return t('已按规则跳过');
            case 'unresolved':
            case 'retain_previous': return t('源素材缺失，保留上一代产物');
            default: return g.action ?? '—';
        }
    }

    function _applyBackground() {
        const light = dialogState.background === 'light';
        originalCard.box.remove_css_class('light-mode');
        proposedCard.box.remove_css_class('light-mode');
        if (light) {
            originalCard.box.add_css_class('light-mode');
            proposedCard.box.add_css_class('light-mode');
        }
    }

    function _syncControls() {
        syncingControls = true;
        try {
        for (const [size, button] of sizeButtons) {
            button.set_active(size === dialogState.size);
        }
        backgroundButton.set_active(dialogState.background === 'dark');
        skipButton.set_label(group.skipped ? t('取消跳过') : t('跳过此图标'));
        } finally {
            syncingControls = false;
        }
    }

    // ------------------------------------------------------------- data flow
    async function fetchPreview() {
        const generation = ++previewGeneration;
        originalCard.setLoading();
        proposedCard.setLoading();
        const envelope = await call(controlPath, 'preview', {
            icon_id: group.icon_id,
            source_sha256: group.source_sha256,
            size: dialogState.size,
        });
        if (generation !== previewGeneration) return envelope;
        if (!envelope.ok) {
            originalCard.setError(actionLabel(envelope.error));
            proposedCard.setError(actionLabel(envelope.error));
            return envelope;
        }
        const result = envelope.result;
        originalCard.setPicture(
            result.original_png_base64,
            t('占比 {ratio}%', {ratio: ((result.metrics.source_ratio ?? 0) * 100).toFixed(1)}));
        proposedCard.setPicture(
            result.proposed_png_base64,
            result.metrics.measured_after_ratio !== undefined
                ? t('目标 {target}% · 实测 {measured}%', {
                    target: (result.effective_policy.target * 100).toFixed(0),
                    measured: (result.metrics.measured_after_ratio * 100).toFixed(1)})
                : t('目标 {target}%', {target: (result.effective_policy.target * 100).toFixed(0)}),
        );
        return envelope;
    }

    async function toggleSkip(g, onDone) {
        const statusEnvelope = await call(controlPath, 'status', {});
        if (!statusEnvelope.ok) {
            toast(parent, actionLabel(statusEnvelope.error));
            return;
        }
        const revision = statusEnvelope.result.revision;
        const rule = g.skipped ? {reset: true} : {skip: true, classification: 'auto'};
        const envelope = await call(controlPath, 'rules.set', {
            expected_revision: revision,
            icon_id: g.icon_id,
            rule,
        });
        if (!envelope.ok) {
            toast(parent, actionLabel(envelope.error));
            return;
        }
        toast(parent, g.skipped ? t('已取消跳过') : t('已跳过该图标'));
        g.skipped = !g.skipped;
        _syncControls();
        onRuleChanged?.();
        onDone();
    }

    _syncControls();
    _applyBackground();
    const handle = presentDialog(parent, t('{name} · 效果预览', {name: group.names?.[0] ?? group.icon_name}),
        root, {width: 800, height: 700});
    handle.ready = fetchPreview();
    return handle;
}

function _makeStage(title) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: ['preview-stage-card'],
        valign: Gtk.Align.START,
    });
    const label = new Gtk.Label({label: title, css_classes: ['heading']});
    const stack = new Gtk.Stack({vhomogeneous: false});
    const spinner = new Gtk.Spinner({spinning: true, width_request: 48, height_request: 48});
    const placeholder = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8,
        valign: Gtk.Align.CENTER});
    placeholder.append(spinner);
    const errorLabel = new Gtk.Label({wrap: true, css_classes: ['dimmed']});
    const ratioLabel = new Gtk.Label({wrap: true, css_classes: ['mono-stat', 'caption']});
    stack.add_named(placeholder, 'loading');
    stack.add_named(new Gtk.Box(), 'empty');
    stack.add_named(errorLabel, 'error');
    stack.set_visible_child(placeholder);
    box.append(label);
    box.append(stack);
    box.append(ratioLabel);
    return {
        box,
        setLoading() {
            spinner.start();
            stack.set_visible_child(placeholder);
            ratioLabel.set_text('');
        },
        setError(message) {
            spinner.stop();
            errorLabel.set_text(message);
            stack.set_visible_child(errorLabel);
        },
        setPicture(b64, ratioText) {
            spinner.stop();
            const previous = stack.get_child_by_name('current-picture');
            const picture = pictureFromBase64(b64, 160);
            stack.add_named(picture, 'current-picture');
            stack.set_visible_child(picture);
            if (previous) stack.remove(previous);
            ratioLabel.set_text(ratioText);
        },
    };
}
