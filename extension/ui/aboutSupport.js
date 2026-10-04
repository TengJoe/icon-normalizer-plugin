// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {t} from '../lib/i18n.js';
import {AUTHOR, PROJECT_URL, ISSUE_URL, LICENSE, SUPPORT_METHODS} from '../lib/projectInfo.js';
import {presentDialog, toast, translateWidgetTree} from '../lib/uiCommon.js';

export class AboutSupport {
    constructor(window) {
        this._window = window;
        this._dialog = null;
        this._launches = new Set();
        this._extensionDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
        this.group = new Adw.PreferencesGroup({title: t('关于与支持')});
        this.group.add(this._valueRow(t('作者'), AUTHOR));
        const [, contents] = this._extensionDir.get_child('metadata.json').load_contents(null);
        const metadata = JSON.parse(new TextDecoder().decode(contents));
        this.group.add(this._valueRow(t('扩展版本'), String(metadata['version-name'])));
        this.group.add(this._linkRow(t('项目主页'), t('查看源码与使用说明。'), PROJECT_URL));
        this.group.add(this._linkRow(t('问题反馈'), t('报告问题或提出建议。'), ISSUE_URL));
        this.group.add(this._valueRow(t('许可证'), LICENSE));
        this.methods = new Map();
        for (const method of SUPPORT_METHODS) {
            const row = new Adw.ActionRow({title: t(method.label),
                subtitle: t('扫描收款码，自愿支持开发。'), activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'view-reveal-symbolic'}));
            row.connect('activated', () => this.open(method.id));
            this.methods.set(method.id, {method, row});
            this.group.add(row);
        }
        if (this.methods.size)
            this.group.set_description(t('自愿支持开发，所有功能均可免费使用。'));
        window.connect('close-request', () => {
            this._dialog?.close();
            this._dialog = null;
            for (const cancellable of this._launches) cancellable.cancel();
            return false;
        });
    }

    _valueRow(title, value) {
        const row = new Adw.ActionRow({title, subtitle: value});
        row._normalizerDataProperties = ['subtitle'];
        return row;
    }

    _linkRow(title, subtitle, uri) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        row.connect('activated', () => this._openUri(uri));
        return row;
    }

    _openUri(uri) {
        const cancellable = new Gio.Cancellable();
        this._launches.add(cancellable);
        const launcher = new Gtk.UriLauncher({uri});
        launcher.launch(this._window, cancellable, (source, result) => {
            this._launches.delete(cancellable);
            try {
                source.launch_finish(result);
            } catch (error) {
                if (!cancellable.is_cancelled()) toast(this._window, t('无法打开链接，请检查默认浏览器。'));
            }
        });
    }

    open(id) {
        const entry = this.methods.get(id);
        if (!entry) return null;
        this._dialog?.close();
        const {method} = entry;
        let texture;
        try {
            texture = Gdk.Texture.new_from_file(this._extensionDir.resolve_relative_path(method.asset));
        } catch (error) {
            toast(this._window, t('收款码无法加载，请从项目主页查看支持方式。'));
            return null;
        }
        const picture = new Gtk.Picture({paintable: texture, can_shrink: true,
            content_fit: Gtk.ContentFit.CONTAIN, alternative_text: t(method.label)});
        const imageClamp = new Adw.Clamp({maximum_size: 340, tightening_threshold: 300, child: picture});
        const caption = new Gtk.Label({label: t('请使用对应支付应用扫描，并核对收款人。'),
            wrap: true, xalign: 0, css_classes: ['dimmed']});
        const notice = new Gtk.Label({label: t('自愿支持开发，所有功能均可免费使用。'),
            wrap: true, xalign: 0});
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 16,
            margin_top: 16, margin_bottom: 24, margin_start: 24, margin_end: 24});
        content.append(imageClamp);
        content.append(caption);
        content.append(notice);
        const scroll = new Gtk.ScrolledWindow({child: content, vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC});
        const toolbar = new Adw.ToolbarView({content: scroll});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = presentDialog(this._window, t(method.label), toolbar, {width: 420, height: 640});
        this._dialog = dialog;
        dialog.picture = picture;
        dialog.method = method;
        dialog.widget.connect(dialog.widget instanceof Adw.Dialog ? 'closed' : 'close-request', () => {
            if (this._dialog === dialog) this._dialog = null;
            return false;
        });
        return dialog;
    }

    retranslate() {
        if (this._dialog) {
            translateWidgetTree(this._dialog.widget);
            this._dialog.picture.set_alternative_text(t(this._dialog.method.label));
        }
    }
}
