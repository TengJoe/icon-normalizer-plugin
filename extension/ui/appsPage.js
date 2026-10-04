// SPDX-License-Identifier: GPL-3.0-or-later
// Apps page: virtualized icon list (Gtk.ListView + Gio.ListStore), instant
// fuzzy search, filter pills, and the live before/after preview dialog.
// Excluded leftover launchers (uninstalled software) are hidden by default
// and available under their own pill.
import {t} from '../lib/i18n.js';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {call} from '../lib/backendClient.js';
import {
    FILTERS,
    actionLabel,
    badgeFor,
    groupMatchesFilter,
    groupMatchesSearch,
    groupSubtitle,
} from '../lib/stateModel.js';
import {cachedTexture, configurePage, makePills, observeWindowSize, statusBadge, toast} from '../lib/uiCommon.js';
import {openPreview} from './previewDialog.js';

const AppGroupItem = GObject.registerClass({
    GTypeName: 'IconNormalizerAppGroupItem',
    Properties: {
        'group-title': GObject.ParamSpec.string('group-title', '', '',
            GObject.ParamFlags.READWRITE, ''),
        'subtitle': GObject.ParamSpec.string('subtitle', '', '',
            GObject.ParamFlags.READWRITE, ''),
        'badge-text': GObject.ParamSpec.string('badge-text', '', '',
            GObject.ParamFlags.READWRITE, ''),
        'badge-class': GObject.ParamSpec.string('badge-class', '', '',
            GObject.ParamFlags.READWRITE, ''),
        'icon-path': GObject.ParamSpec.string('icon-path', '', '',
            GObject.ParamFlags.READWRITE, ''),
        'previewable': GObject.ParamSpec.boolean('previewable', '', '',
            GObject.ParamFlags.READWRITE, false),
    },
}, class AppGroupItem extends GObject.Object {
});

let _placeholderPaintable = null;
function placeholderPaintable() {
    // Uniform 48px shape for rows whose source artwork is gone (excluded or
    // unresolved leftovers): keeps list rhythm instead of empty gaps.
    if (_placeholderPaintable) return _placeholderPaintable;
    try {
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        _placeholderPaintable = theme.lookup_icon(
            'image-missing-symbolic', [], 48, 1, Gtk.TextDirection.NONE, 0);
    } catch (err) {
        _placeholderPaintable = null;
    }
    return _placeholderPaintable;
}

export class AppsPage {
    constructor(controlPath, win, settings) {
        this._controlPath = controlPath;
        this._win = win;
        this._settings = settings;
        this._groups = [];
        const saved = settings.get_string('list-filter');
        this._filter = FILTERS.some(f => f.id === saved) ? saved : 'all';
        this._needle = '';
        this._build();
        this._stopObserving = observeWindowSize(win, () => this._resizeList(),
            () => `${this.page.get_mapped()}:${this.page.get_height()}:${this._controls.get_height()}`);
    }

    _build() {
        this.page = configurePage(new Adw.PreferencesPage({
            title: t('应用图标'),
            icon_name: 'view-app-grid-symbolic',
        }));

        // ---- controls group: search + filter pills --------------------
        this._controls = new Adw.PreferencesGroup({
            title: t('应用图标管理'),
            description: t('正在扫描…'),
        });
        this.page.add(this._controls);

        const searchRow = new Adw.ActionRow();
        this._search = new Gtk.SearchEntry({
            placeholder_text: t('搜索应用名称或图标名…'),
            hexpand: true,
        });
        this._search.connect('search-changed', () => {
            this._needle = this._search.text.trim().toLowerCase();
            this._render();
        });
        searchRow.set_child(this._search);
        this._controls.add(searchRow);

        const pills = makePills(FILTERS, this._filter, id => {
            this._filter = id;
            this._settings.set_string('list-filter', id);
            this._render();
        });
        const pillsRow = new Adw.ActionRow();
        pillsRow.set_child(pills.widget);
        this._controls.add(pillsRow);

        // ---- list group: the virtualized list, alone in its card -------
        const listGroup = new Adw.PreferencesGroup();
        this.page.add(listGroup);

        this._store = new Gio.ListStore({item_type: AppGroupItem});
        this._selection = new Gtk.NoSelection({model: this._store});
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_obj, listItem) => this._setupRow(listItem));
        factory.connect('bind', (_obj, listItem) => this._bindRow(listItem));
        this._view = new Gtk.ListView({
            model: this._selection,
            factory,
            single_click_activate: true,
            css_classes: ['normalizer-app-list'],
        });
        this._view.connect('activate', (_view, position) => {
            const item = this._selection.get_item(position);
            if (item && item.previewable) this.openPreview(item.group);
        });
        this._scrolled = new Gtk.ScrolledWindow({
            propagate_natural_height: false,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: 180,
            vexpand: true,
            child: this._view,
        });
        listGroup.add(new Adw.PreferencesRow({child: this._scrolled,
            activatable: false, selectable: false}));
        this._pills = pills;
    }

    _resizeList() {
        if (!this.page.get_mapped()) return;
        const height = Math.max(180, this.page.get_height() - this._controls.get_height() - 72);
        if (height === this._listHeight) return;
        this._listHeight = height;
        this._scrolled.set_max_content_height(-1);
        this._scrolled.set_min_content_height(height);
        this._scrolled.set_max_content_height(height);
        this._scrolled.set_size_request(-1, height);
    }

    _setupRow(listItem) {
        const row = new Gtk.Box({spacing: 12, margin_top: 4, margin_bottom: 4});
        const picture = new Gtk.Picture({can_shrink: true});
        picture.set_size_request(48, 48);
        const textBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const title = new Gtk.Label({xalign: 0, ellipsize: 3 /* Pango.EllipsizeMode.END */});
        title._normalizerUserText = true;
        title.add_css_class('heading');
        const subtitle = new Gtk.Label({xalign: 0, ellipsize: 3});
        subtitle.add_css_class('dimmed');
        subtitle.add_css_class('caption');
        textBox.append(title);
        textBox.append(subtitle);
        const badge = statusBadge('');
        const previewButton = new Gtk.Button({
            icon_name: 'view-reveal-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: t('实时对比预览'),
            css_classes: ['flat'],
        });
        row.append(picture);
        row.append(textBox);
        row.append(badge);
        row.append(previewButton);
        listItem.set_child(row);
        listItem._widgets = {picture, title, subtitle, badge, previewButton};
        previewButton.connect('clicked', () => {
            const item = listItem.get_item();
            if (item && item.previewable) this.openPreview(item.group);
        });
    }

    _bindRow(listItem) {
        const item = listItem.get_item();
        const {picture, title, subtitle, badge, previewButton} = listItem._widgets;
        title.set_text(item.group_title);
        title.set_tooltip_text((item.group.names ?? [item.group_title]).join('、'));
        subtitle.set_text(item.subtitle);
        subtitle.set_tooltip_text(item.subtitle);
        badge.set_text(item.badge_text);
        badge.set_css_classes(['badge-pill', item.badge_class]);
        previewButton.set_visible(item.previewable);
        previewButton.set_tooltip_text(t('实时对比预览'));
        let texture = null;
        if (item.icon_path && item.icon_path.startsWith('/')) {
            try {
                texture = cachedTexture(`file:${item.icon_path}`,
                    () => Gdk.Texture.new_from_filename(item.icon_path));
            } catch (err) {
                logError(err, 'icon-normalizer: row icon decode failed');
            }
        }
        // Uniform row rhythm: missing artwork gets a themed placeholder.
        picture.set_paintable(texture ?? placeholderPaintable());
    }

    async refresh() {
        if (this._scanPromise) return this._scanPromise;
        this._scanPromise = this._refresh();
        try { return await this._scanPromise; }
        finally { this._scanPromise = null; }
    }

    async _refresh() {
        this._controls.set_description(t('正在扫描…'));
        let envelope;
        for (let attempt = 0; attempt < 4; attempt++) {
            envelope = await call(this._controlPath, 'scan', {});
            if (envelope.ok || envelope.error?.code !== 'BUSY' || attempt === 3) break;
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                resolve(); return GLib.SOURCE_REMOVE;
            }));
        }
        if (!envelope.ok) {
            this._controls.set_description(actionLabel(envelope.error));
            toast(this._win, actionLabel(envelope.error));
            await this.onScan?.(envelope);
            return envelope;
        }
        this._groups = envelope.result.groups ?? [];
        this._render();
        await this.onScan?.(envelope);
        return envelope;
    }

    _render() {
        this._store.remove_all();
        const visible = this._groups.filter(g =>
            groupMatchesSearch(g, this._needle) && groupMatchesFilter(g, this._filter));
        for (const g of visible) {
            const badge = badgeFor(g);
            const item = new AppGroupItem();
            item.group = g;
            item.group_title = g.names?.[0] || g.icon_name;
            item.subtitle = this._subtitleFor(g);
            item.badge_text = badge.label;
            item.badge_class = badge.css;
            item.icon_path = g.source_path ?? '';
            item.previewable = Boolean(g.source_sha256) && g.action !== 'excluded';
            this._store.append(item);
        }
        const total = this._groups.length;
        this._controls.set_description(
            visible.length === total
                ? t('共 {total} 组候选（已排除的残留入口在“已排除”胶囊下）', {total})
                : t('共 {total} 组 · 当前显示 {visible} 组', {total, visible: visible.length}));
    }

    _subtitleFor(g) {
        const base = groupSubtitle({...g,
            target_ratio: this._policy?.target,
            inner_target_ratio: this._policy ? this._policy.target * this._policy.inner : undefined});
        if (g.action !== 'excluded') return base;
        // Surface WHERE the leftover launcher lives so it can be cleaned up.
        const entries = (g.desktop_ids ?? []).join('、');
        return entries ? t('{base} · 残留入口：{entries}', {base, entries}) : base;
    }

    setPolicy(policy) {
        this._policy = policy;
        this._render();
    }

    destroy() { this._stopObserving?.(); this._stopObserving = null; }

    openPreview(group) {
        openPreview(this._win, group, {
            controlPath: this._controlPath,
            settings: this._settings,
            onRuleChanged: () => this.refresh(),
        });
    }
}
