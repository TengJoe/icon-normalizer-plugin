# Icon Normalizer v1.1.1 — 首个公开版本 / First public release

前端 / Frontend **1.1.1** · 配套后台 / Companion backend **3.1.0** ·
实测支持 / Verified support **GNOME Shell 51** · 作者 / Author **TengJoe**

## 功能 / Features

- 应用图标视觉大小与底板归一化，原始系统素材保持只读，支持恢复托管修改。
  Normalize application icon size and tiles, keep system artwork read-only, and restore managed changes.
- 自定义命名方案、逐图标跳过规则、主题跟随与独立自动维护。
  Named profiles, per-icon skip rules, icon-theme following, and independent automatic maintenance.
- 自适应设置窗口、图标预览、单色顶栏按钮、简体中文与 English 即时切换。
  Adaptive preferences, icon previews, a symbolic panel icon, and live Chinese/English switching.
- 作者署名、项目与反馈链接，以及自愿支持开发的微信/支付宝收款码。
  Author attribution, project/issue links, and optional WeChat Pay/Alipay support codes.

## 下载与安装 / Download and install

| 文件 / Asset | 用途 / Purpose |
|---|---|
| `icon-normalizer-plugin-1.1.1.tar.gz` | 首次完整安装：扩展、后台与安装工具 / Complete first installation: extension, backend and installer |
| `icon-normalizer@joeydeng.local.zip` | 扩展前端安装/升级与 GNOME Extensions 提交包；不含后台 / Frontend installation/upgrades and GNOME Extensions submission; backend not included |
| `DIST_MANIFEST.json` | 组件版本与两个安装包的 SHA-256 / Component versions and package SHA-256 hashes |
| `SHA256SUMS` | 下载文件完整性校验 / Download integrity checks |

准备 GNOME Shell 51 和 [README](../README.md) 中的运行依赖后，以普通用户执行：
Prepare GNOME Shell 51 and the dependencies in [README.en.md](../README.en.md), then run as your normal user:

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

面板代码升级后，保存工作再注销、重新登录；设置窗口可关闭后重开。
After panel code upgrades, save your work and log out/in. Preferences can be closed and reopened.

## 验证与范围 / Validation and scope

前端验证包括 17 个 JavaScript 文件、38 项逻辑检查、9 项真实 GTK 场景。
两张原始收款码与 8 个中英文宽窄窗口渲染结果的二维码内容一致。
发行包经过严格 schema 编译、源码一致性和隐私检查。
Frontend validation covers 17 JavaScript files, 38 logic checks, and 9 real GTK scenarios.
Eight rendered payment codes match the two original codes across languages and window sizes.
Packages pass strict schema compilation, source/archive consistency and privacy checks.

- 本版仅声明实测 GNOME Shell 51；其他版本尚未声明支持。
  Only verified GNOME Shell 51 support is declared.
- Python 后台需要单独安装；扩展 ZIP 单独安装不提供图标处理后台。
  The Python companion must be installed separately; the extension ZIP alone does not provide icon processing.
- 托盘图标及应用自行绘制的图标不经过图标主题，属于处理范围之外。
  Tray icons and icons drawn directly by apps bypass icon themes and are outside the normalization scope.
- 尚未提交 GNOME Extensions 商店；GitHub 发布不代表 GNOME 审核通过。
  Not submitted to GNOME Extensions; this GitHub release does not imply GNOME review approval.
- Wise 待提供公开收款链接后再接入，银行账户截图未发布；实际付款尚未测试。
  Wise awaits a public payment link; bank-account screenshots are excluded and actual payments have not been tested.

[问题反馈 / Report an issue](https://github.com/TengJoe/icon-normalizer-plugin/issues) ·
[支持开发 / Support development](SUPPORT.md) · [GPL-3.0-or-later](../LICENSE)
