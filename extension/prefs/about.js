// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {AUTHOR, PROJECT_URL, ISSUE_URL, LICENSE} from '../shared/projectInfo.js';
import {t} from '../shared/i18n.js';
import {WindowScope} from './requestScope.js';
import {toast} from './uiCommon.js';

export class About {
    constructor(window) {
        this._window = window;
        this._scope = new WindowScope(window);
        this.group = new Adw.PreferencesGroup({title: t('关于')});
        this.group.add(this._valueRow(t('作者'), AUTHOR));
        const directory = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
        const [, contents] = directory.get_child('metadata.json').load_contents(null);
        const metadata = JSON.parse(new TextDecoder().decode(contents));
        this.group.add(this._valueRow(t('扩展版本'), String(metadata['version-name'])));
        this.group.add(this._linkRow(t('项目主页'), t('查看源码与使用说明。'), PROJECT_URL));
        this.group.add(this._linkRow(t('问题反馈'), t('报告问题或提出建议。'), ISSUE_URL));
        this.group.add(this._valueRow(t('许可证'), LICENSE));
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
        const detach = this._scope.cleanup(() => cancellable.cancel());
        new Gtk.UriLauncher({uri}).launch(this._window, cancellable, (source, result) => {
            detach();
            try {
                source.launch_finish(result);
            } catch (error) {
                if (!cancellable.is_cancelled()) toast(this._window, t('无法打开链接，请检查默认浏览器。'));
            }
        });
    }

    destroy() {
        this._scope.close();
        this._window = null;
    }
}
