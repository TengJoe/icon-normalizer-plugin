// SPDX-License-Identifier: GPL-3.0-or-later
// Shared UI primitives: signal-safe switch binding, filter pills, texture
// cache, CSS loading and the Adw.Dialog/GNOME-45 compatibility layer.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {t, translateText} from './i18n.js';

export function translateWidgetTree(widget, protectedText = new Set()) {
    if (!widget._normalizerUserText) {
        for (const property of ['title', 'subtitle', 'description', 'label', 'placeholder_text', 'tooltip_text']) {
            if (widget._normalizerDataProperties?.includes(property)) continue;
            const value = widget[property];
            if (typeof value !== 'string' || !value || protectedText.has(value)) continue;
            const translated = translateText(value);
            if (translated !== value) widget[property] = translated;
        }
    }
    const children = [];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) children.push(child);
    const data = new Set([...protectedText, ...(widget._normalizerDataProperties ?? [])
        .map(property => widget[property]).filter(value => typeof value === 'string')]);
    for (const child of children) translateWidgetTree(child, data);
}

export const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];
export const PREVIEW_SIZES = [32, 48, 64, 128, 256];

export function configurePage(page) {
    page.add_css_class('normalizer-page');
    // PreferencesPage owns the scrolling shell. Configure its public Clamp
    // widget without replacing the page's native accessibility/navigation.
    const visit = widget => {
        if (widget instanceof Adw.Clamp) {
            widget.set_maximum_size(960);
            widget.set_tightening_threshold(760);
        }
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
            visit(child);
    };
    visit(page);
    return page;
}

export function actionButton(label, callback, {primary = false, destructive = false} = {}) {
    const button = new Gtk.Button({label, hexpand: true, valign: Gtk.Align.CENTER,
        css_classes: ['normalizer-action', ...(primary ? ['suggested-action'] : []),
            ...(destructive ? ['destructive-action'] : [])]});
    button.connect('clicked', callback);
    return button;
}

export function statusBadge(text, tone = 'badge-keep') {
    return new Gtk.Label({label: text, valign: Gtk.Align.CENTER, halign: Gtk.Align.END,
        css_classes: ['badge-pill', tone]});
}

export function adaptiveBox(children, {spacing = 8, below = 560, homogeneous = true} = {}) {
    // Let GTK measure wrapped rows itself. A fixed-height BreakpointBin can
    // retain the previous row height during a resize or language change.
    const box = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: spacing, row_spacing: spacing,
        min_children_per_line: 1, max_children_per_line: children.length,
        homogeneous, hexpand: true, css_classes: ['normalizer-adaptive']});
    for (const child of children) {
        child.set_hexpand(true);
        box.insert(child, -1);
    }
    const updateLayout = () => {
        const width = box.get_width();
        if (!width) return;
        const columns = width <= below ? 1 : children.length;
        if (box.get_max_children_per_line() !== columns)
            box.set_max_children_per_line(columns);
    };
    box.add_tick_callback(() => { updateLayout(); return GLib.SOURCE_CONTINUE; });
    return {widget: box, box, children, updateLayout};
}

export function actionGroup(title, buttons, description = '') {
    const group = new Adw.PreferencesGroup({title, description});
    const layout = adaptiveBox(buttons);
    layout.widget.set_margin_top(12);
    layout.widget.set_margin_bottom(12);
    layout.widget.set_margin_start(12);
    layout.widget.set_margin_end(12);
    group.add(new Adw.PreferencesRow({child: layout.widget,
        activatable: false, selectable: false}));
    return {group, ...layout};
}

export function noticeRow() {
    const row = new Adw.ActionRow({visible: false, title_lines: 2,
        css_classes: ['normalizer-notice']});
    const icon = new Gtk.Image({icon_name: 'dialog-information-symbolic'});
    row.add_prefix(icon);
    const button = actionButton('', () => callback?.());
    button.set_hexpand(false);
    button.set_visible(false);
    row.add_suffix(button);
    let callback = null;
    return {
        row,
        hide() { row.set_visible(false); },
        show(text, {error = false, success = false, buttonLabel = '', onClick = null} = {}) {
            row.set_title(text);
            row.set_visible(true);
            icon.set_from_icon_name(error ? 'dialog-warning-symbolic'
                : success ? 'emblem-ok-symbolic' : 'dialog-information-symbolic');
            row.remove_css_class('notice-error');
            row.remove_css_class('notice-success');
            if (error) row.add_css_class('notice-error');
            if (success) row.add_css_class('notice-success');
            button.set_label(buttonLabel);
            button.set_visible(Boolean(buttonLabel && onClick));
            callback = onClick;
        },
    };
}

export function observeWindowSize(window, callback, extraSize = () => '') {
    let width = -1;
    let height = -1;
    let extra = null;
    // Observe GTK allocation changes on the frame clock; perform no work when
    // unchanged. No timer, backend polling or file I/O is involved.
    const id = window.add_tick_callback(() => {
        const w = window.get_width();
        const h = window.get_height();
        const e = extraSize();
        if (w !== width || h !== height || e !== extra) {
            width = w;
            height = h;
            extra = e;
            callback(w, h);
        }
        return GLib.SOURCE_CONTINUE;
    });
    const closeId = window.connect('close-request', () => {
        window.remove_tick_callback(id);
        return false;
    });
    return () => {
        window.remove_tick_callback(id);
        window.disconnect(closeId);
    };
}

/**
 * Bind a switch row to a change handler with programmatic-update protection.
 * Returns a setter used to refresh the widget without re-triggering `onChange`
 * (kills the classic set_active → notify::active feedback loop).
 */
export function bindSwitch(row, onChange) {
    let syncing = false;
    row.connect('notify::active', () => {
        if (syncing) return;
        onChange(row.active);
    });
    return value => {
        syncing = true;
        try {
            row.set_active(value);
        } finally {
            syncing = false;
        }
    };
}

/**
 * A row of pill toggle buttons behaving as a radio group.
 * Returns {widget, setSelection}.
 */
export function makePills(options, initialId, onSelect) {
    const box = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 6, row_spacing: 6, min_children_per_line: 1,
        max_children_per_line: options.length, homogeneous: true,
        css_classes: ['normalizer-filters']});
    const buttons = new Map();
    let selection = initialId;
    let syncing = false;

    const setSelection = (id, notify = true) => {
        selection = id;
        syncing = true;
        try {
            for (const [key, button] of buttons) {
                button.set_active(key === id);
            }
        } finally {
            syncing = false;
        }
        if (notify) onSelect(id);
    };

    for (const option of options) {
        const button = new Gtk.ToggleButton({label: t(option.label),
            css_classes: ['normalizer-filter']});
        button.connect('toggled', () => {
            if (syncing) return;
            if (!button.active && selection === option.id) {
                syncing = true;
                button.set_active(true);
                syncing = false;
                return;
            }
            if (!button.active) return;
            setSelection(option.id);
        });
        buttons.set(option.id, button);
        box.insert(button, -1);
    }
    setSelection(initialId, false);
    return {widget: box, setSelection, buttons};
}

// ---------------------------------------------------------------- textures
const textureCache = new Map();

export function textureFromBase64(b64) {
    const bytes = GLib.base64_decode(b64);
    return Gdk.Texture.new_from_bytes(new GLib.Bytes(bytes));
}

export function cachedTexture(key, factory) {
    if (textureCache.has(key)) return textureCache.get(key);
    const texture = factory();
    if (textureCache.size > 512) textureCache.clear();
    textureCache.set(key, texture);
    return texture;
}

export function pictureFromBase64(b64, pixelSize = 112) {
    try {
        const picture = new Gtk.Picture({
            paintable: textureFromBase64(b64),
            can_shrink: true,
        });
        picture.set_size_request(pixelSize, pixelSize);
        return picture;
    } catch (err) {
        logError(err, 'icon-normalizer: preview decode failed');
        return new Gtk.Image({icon_name: 'image-missing-symbolic', pixel_size: pixelSize});
    }
}

export function pictureFromPath(path, pixelSize = 48) {
    const texture = cachedTexture(`file:${path}`, () => Gdk.Texture.new_from_filename(path));
    if (texture) {
        const picture = new Gtk.Picture({paintable: texture, can_shrink: true});
        picture.set_size_request(pixelSize, pixelSize);
        return picture;
    }
    return new Gtk.Image({icon_name: 'image-missing-symbolic', pixel_size: pixelSize});
}

// ---------------------------------------------------------------- CSS
let cssApplied = false;

export function ensureCss(moduleUrl, relativePath = '../stylesheet.css') {
    if (cssApplied) return;
    try {
        const file = Gio.File.new_for_uri(moduleUrl).get_parent().resolve_relative_path(relativePath);
        const [, contents] = file.load_contents(null);
        const provider = new Gtk.CssProvider();
        const errors = [];
        provider.connect('parsing-error', (_provider, _section, error) => errors.push(error.message));
        provider.load_from_string(new TextDecoder().decode(contents));
        if (errors.length) throw new Error(errors.join('; '));
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            provider,
            Gtk.StyleContext.STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
        cssApplied = true;
    } catch (err) {
        logError(err, 'icon-normalizer: stylesheet load failed');
    }
}

// ---------------------------------------------------------------- dialogs
export function supportsDialog() {
    return Adw.Dialog !== undefined;
}

/**
 * Present `content` as a modal dialog on `parent`, using Adw.Dialog when the
 * runtime provides it (GNOME 46+, libadwaita 1.5) and an Adw.Window fallback
 * for GNOME 45. Returns an object with close().
 */
export function presentDialog(parent, title, content, {width = 760, height = 680} = {}) {
    if (Adw.Dialog !== undefined) {
        const dialog = new Adw.Dialog({
            title,
            child: content,
            content_width: width,
            content_height: height,
        });
        dialog.present(parent);
        return {close: () => dialog.close(), widget: dialog};
    }
    const window = new Adw.Window({
        title,
        default_width: width,
        default_height: height,
        modal: true,
        transient_for: parent,
    });
    window.set_content(content);
    window.present();
    return {close: () => window.close(), widget: window};
}

export function toast(window, message) {
    try {
        window.add_toast(Adw.Toast.new(message));
    } catch (err) {
        logError(err, 'icon-normalizer: toast failed');
    }
}
