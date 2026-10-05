# Icon Normalizer v1.1.1

首个公开版本 / First public release · **TengJoe** · **GPL-3.0-or-later**

[简体中文](#简体中文) · [English](#english) · [GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1)

## 简体中文

扩展版本 **1.1.1**，配套后台 **3.1.0**，实测支持 **GNOME Shell 51**。

### 功能

- 应用图标视觉占比与底板归一化，原始系统素材只读，可恢复托管修改。
- 自定义命名方案、逐图标跳过规则、主题跟随与独立自动维护。
- 自适应设置窗口、图标对比预览、单色顶栏按钮与中英文即时切换。
- 作者署名、项目与反馈链接，以及自愿支持开发的微信、支付宝收款码。

### 下载与安装

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.1.tar.gz` | 完整安装：扩展、后台与安装工具 |
| `icon-normalizer@joeydeng.local.zip` | 前端安装或升级；不含 Python 后台 |
| `DIST_MANIFEST.json` | 组件版本与安装包的 SHA-256 |
| `SHA256SUMS` | 下载完整性校验 |

首次安装请从 [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1) 下载完整 tar.gz 和 `SHA256SUMS`。准备 [README](../README.md) 中的运行依赖后，在同一目录以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

确认校验输出为 `OK` 后再安装。顶栏代码升级后，保存工作并注销、重新登录；设置窗口可关闭后重开。

### 发布验证与范围

完整发行包通过 **147 项后台测试**和 **17 项安装及故障回归**。前端通过 **17 个 JavaScript 文件检查**、**38 项逻辑检查**和 **9 项真实 GTK 场景**；8 个中英文宽窄窗口中渲染的二维码内容与两张原始收款码一致。构建包含严格 schema 编译、源码与发行包一致性及隐私检查。

本版仅声明 GNOME Shell 51。托盘图标及应用自行绘制的图标可能绕过主题；非默认 `XDG_DATA_HOME` 暂不支持。扩展 ZIP 不包含配套后台，首次安装请使用完整发行包。

本项目尚未提交 GNOME Extensions 商店。收款码的显示与扫描已验证，实际付款尚未测试。支持方式见[支持页面](SUPPORT.md)。

## English

Extension **1.1.1**, companion backend **3.1.0**, verified **GNOME Shell 51**.

### Features

- Normalize application icon coverage and tiles while keeping system artwork read-only and allowing managed changes to be restored.
- Use named profiles, per-icon skip rules, icon-theme following, and independent automatic maintenance.
- Use adaptive preferences, comparison previews, a symbolic panel button, and live Chinese/English switching.
- Find author attribution, project and issue links, and optional WeChat Pay and Alipay support codes.

### Download and install

| Asset | Purpose |
| --- | --- |
| `icon-normalizer-plugin-1.1.1.tar.gz` | Complete installation: extension, backend, and installer |
| `icon-normalizer@joeydeng.local.zip` | Frontend installation or upgrade; no Python backend |
| `DIST_MANIFEST.json` | Component versions and package SHA-256 hashes |
| `SHA256SUMS` | Download integrity checks |

For a first installation, download the complete tarball and `SHA256SUMS` from [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1). Prepare the runtime requirements in [README.en.md](../README.en.md), place both files in the same directory, and run as your normal user:

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

Confirm that the checksum output is `OK` before installing. After panel code upgrades, save your work and log out and back in. Preferences can be closed and reopened.

### Release validation and scope

The complete release passes **147 backend tests** and **17 installation and fault-recovery tests**. Frontend validation covers **17 JavaScript files**, **38 logic checks**, and **9 real GTK scenarios**. Eight rendered codes match the two original payment codes across languages and window sizes. Build checks include strict schema compilation, source/archive consistency, and privacy review.

Only GNOME Shell 51 support is declared. Tray icons and icons drawn directly by applications may bypass icon themes. Non-default `XDG_DATA_HOME` is unsupported. The extension ZIP does not include the companion backend; use the complete tarball for a first installation.

This project has not been submitted to GNOME Extensions. Payment-code display and decoding have been verified; actual payments have not been tested. See the [support page](SUPPORT.md) for support options.

[问题反馈 / Report an issue](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [支持开发 / Support development](SUPPORT.md) · [License](../LICENSE)
