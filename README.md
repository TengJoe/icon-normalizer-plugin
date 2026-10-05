# Icon Normalizer

[English](README.en.md) · [下载 v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1) · [问题反馈](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [支持开发](docs/SUPPORT.md)

Icon Normalizer 为 GNOME 桌面的应用图标统一视觉大小与底板样式，由 GNOME Shell 扩展和用户级 Python 后台组成。原始系统图标保持只读，生成的图标与恢复记录保存在用户目录。

| 项目 | 当前公开版本 |
| --- | --- |
| 扩展 | 1.1.1 |
| 配套后台 | 3.1.0 |
| 实测支持 | GNOME Shell 51 |
| 作者 | [TengJoe](https://github.com/TengJoe) |
| 许可证 | [GPL-3.0-or-later](LICENSE) |

## 功能

- **图标归一化**：调整视觉占比，为适合的图标补充底板，生成 16–512 px 的九档图标。
- **规则与自定义方案**：调整目标占比、容差和 Logo 内层占比；保存、使用、重命名或删除最多 50 套命名方案。
- **应用图标管理**：搜索、筛选、比较原始与归一化图标，并为单个图标设置跳过规则。
- **自动维护与主题跟随**：检测应用入口变化；切换图标主题时保留视觉参数与逐图标规则。
- **自适应中英文界面**：窄窗口下按钮纵排、筛选换行、预览单栏；语言切换保留页面、搜索条件与未保存参数。
- **恢复原样**：还原托管启动器与图标主题；遇到外部编辑时保留修改并报告冲突。

## 安装与升级

### 环境要求

本版仅声明经过运行时验收的 **GNOME Shell 51**。其他版本需要单独验证。

| 用途 | 依赖 |
| --- | --- |
| 设置窗口 | GJS、GTK 4、Libadwaita 及对应的 GI 类型库 |
| 图标处理后台 | Python 3.10 或更新版本、Python GI、GTK 3、GdkPixbuf、Pillow、NumPy |
| 安装与自动维护 | systemd 用户会话、`gtk-update-icon-cache`、`glib-compile-schemas` |

后台使用 GTK 3，设置窗口使用 GTK 4，两者在独立进程中运行。安装器会检查后台与安装工具的依赖；缺失的软件包需按发行版说明另行安装。

### 使用完整发行包

从 [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1) 下载 `icon-normalizer-plugin-1.1.1.tar.gz` 和 `SHA256SUMS`，在同一目录以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

确认校验输出为 `OK` 后再安装。完整发行包包含扩展、后台与安装工具，适合首次安装或整体升级。安装器会创建快照、暂存并验证文件、替换代码和检查后台；升级失败时恢复快照。

发行页中的 `icon-normalizer@joeydeng.local.zip` 仅包含扩展前端，适合已有配套后台时更新前端。自定义方案与主题跟随需要后台 3.1.0 或更新版本；旧后台会显示升级提示。

按 GNOME 审核规则（EGO-P-006），该 ZIP **不包含编译好的 `schemas/gschemas.compiled`**：商店会在上传时自行编译。如果你用 `gnome-extensions install` 手动安装这个 ZIP，请补一条命令，否则设置项无法读取：

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/icon-normalizer@joeydeng.local/schemas
```

用 `python3 tools/install.py` 从源码或完整发行包安装时不需要这一步，安装器会自行编译。

### 从源码安装

在项目根目录执行：

```bash
python3 tools/build.py
python3 tools/install.py
```

构建结果位于 `dist/`，包含扩展 ZIP、完整发行包和 `DIST_MANIFEST.json`。开发检查与测试命令见[贡献指南](CONTRIBUTING.md)。

升级后，关闭并重新打开设置窗口即可加载新的设置界面。顶栏代码受 GNOME Shell 模块缓存影响，需要保存工作后注销、重新登录；安装器不会自动结束会话。

## 使用

从扩展管理器打开 **Icon Normalizer → 设置**。

| 页面 | 常用操作 |
| --- | --- |
| 规则 | 调整视觉参数，选择预设或自定义方案，点击“仅保存”或“保存并应用” |
| 应用图标 | 搜索与筛选图标，打开对比预览，设置逐图标跳过规则 |
| 维护 | 查看状态，执行“立即检查”“立即应用”“应用并激活”，设置自动维护、主题跟随与界面语言 |

“标准”预设为 **88%** 目标占比、**±2 个百分点**容差和 **72%** Logo 内层占比。九档输出尺寸为 `16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 px`。

### 自定义方案与主题跟随

“保存为自定义方案”保存当前参数；“使用方案”只填入参数草稿。点击“仅保存”或“保存并应用”后，参数才成为生效配置。方案不绑定图标主题。

“维护 → 跟随图标主题”默认开启。自动维护也开启时，切换到另一个已安装的图标主题会重新生成 `DockNormalized`，保留视觉参数和逐图标规则。最近选择的素材主题成为还原目标；迁移失败时恢复原有图标、配置与还原记录。

切换 GTK 或 GNOME Shell 外观主题不改变视觉参数。重新选择当前的素材主题不会强制激活归一化主题；需要重新启用效果时，点击“应用并激活”。

### 自动维护、语言与顶栏

自动维护通过用户级 `icon-normalizer.path` 检测应用入口变化，并由 `icon-normalizer.timer` 每分钟检查兜底。处理完成时间取决于事件检测和图标数量；关闭设置窗口或锁屏不会停止后台维护。

在“维护 → 界面语言”选择“跟随系统”“简体中文”或“English”。顶栏与设置共用语言偏好，切换后即时更新。

顶栏按钮默认关闭。在“维护 → 显示顶栏按钮”开启后，可通过单色图标查看状态、检查或应用图标，以及打开设置。

## 恢复与卸载

在“维护 → 还原桌面图标”点击“还原”，确认后恢复托管修改与最近选择的素材主题。未被外部编辑的托管启动器按原始字节还原；冲突会保留外部编辑并报告失败。

在完整发行包或源码目录中执行：

```bash
# 先恢复托管修改，再卸载扩展与后台。
python3 tools/uninstall.py

# 仅移除扩展，保留后台与自动维护服务。
python3 tools/uninstall.py --keep-backend
```

备份保留在 `~/.local/state/icon-normalizer/backups/`。恢复失败时先保留状态文件与托管目录，再按[验收与恢复说明](docs/CHECKLIST.md)处理。

## 支持范围

- 托盘与 AppIndicator 图标，以及由应用直接绘制或从文件加载的窗口图标，可能绕过图标主题，无法归一化。
- 非默认 `XDG_DATA_HOME` 暂不支持，安装检查会拒绝该环境。
- 本版提供 GitHub 下载与本地安装，尚未提交 GNOME Extensions 商店。发布到 GitHub 不代表通过 GNOME 审核。

## 文档与贡献

[文档索引](docs/README.md)按使用、开发和发布场景列出参考资料。欢迎通过 [Issues](https://github.com/TengJoe/icon-normalizer-plugin/issues) 报告问题或提出建议。

| 文档 | 内容 |
| --- | --- |
| [贡献指南](CONTRIBUTING.md) | 开发检查、问题反馈与中英文写作规范 |
| [架构说明](ARCHITECTURE.md) | 模块职责、进程隔离、事务与数据流 |
| [协议规范](PROTOCOL.md) | JSON 请求、错误码、并发控制与等待预算 |
| [发布验收](docs/CHECKLIST.md) | 自动检查、手动验收与恢复步骤 |
| [发布记录](CHANGELOG.md) | 版本变更；[v1.1.1 说明](docs/RELEASE-1.1.1.md)介绍首个公开版本 |

## 作者与支持

作者：**[TengJoe](https://github.com/TengJoe)**。所有功能均可免费使用，支持开发完全自愿，没有金额要求。

仓库的 **Sponsor** 入口、[支持页面](docs/SUPPORT.md)和“维护 → 关于与支持”均可查看微信与支付宝收款码。

<details>
<summary>查看微信与支付宝收款码</summary>

### 微信支付

<img src="extension/assets/support/wechat.png" alt="微信支付收款码" width="280">

### 支付宝

<img src="extension/assets/support/alipay.jpg" alt="支付宝收款码" width="280">

请使用对应支付应用扫描，并在应用内核对收款人和金额。支付由微信或支付宝完成，插件不读取或验证交易。

</details>
