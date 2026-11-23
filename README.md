<div align="center">

<img src="extension/icons/icon-normalizer-symbolic.svg" alt="Icon Normalizer 项目标识" width="56" height="56">

# Icon Normalizer

**统一图标占比，保留原有设计。**

为 GNOME 桌面提供图标归一化、自定义方案与自动维护。

[![Release 1.3.10](https://img.shields.io/badge/release-1.3.10-3584e4?style=flat-square)](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.3.10)
[![Verified GNOME Shell 51](https://img.shields.io/badge/GNOME_Shell-51-4a86cf?style=flat-square)](#兼容与依赖)
[![中文 / English](https://img.shields.io/badge/界面-中文%20%2F%20English-813e9e?style=flat-square)](README.en.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-77767b?style=flat-square)](LICENSE)


</div>

**一句话**：Dock 和应用程序网格里的图标，有的贴边、有的留白很大，看上去大小不一。Icon Normalizer 把每个图标的主体统一到同一占比（预设 83% / 88% / 92%），并为缺少底板的裸 Logo 补上底板 —— **不修改任何原图**。

<details>
<summary>和 Dash to Dock 有什么区别？</summary>

两者互补，可以同时启用：Dash to Dock 管理 **Dock 本身**（位置、自动隐藏、外观、模糊），Icon Normalizer 管理 **图标内容**（主体占比、底板、16–512 px 九档尺寸）。

Icon Normalizer 不改任何系统图标文件：它在专属主题 `DockNormalized` 里生成新图，原始图标只读，随时可还原。

</details>

## 架构

GJS 负责 GNOME 顶栏、主题事件和设置。按需启动的 Python 进程通过 Pillow、NumPy 和 GTK 3 查找与渲染图标。所有写操作共用同一把锁和恢复日志。

## 效果预览

![Icon Normalizer 真实预览：ChatGPT、Cursor、Discord、Telegram、Chrome 和 Firefox 在等大画布上的原始与归一化输出，以及四项常用功能](docs/assets/icon-normalizer-overview-actual.png)

*真实 PNG 排版，无 AI 重绘。示例使用标准预设：88% 目标占比、±2 个百分点容差、72% Logo 内层占比。*

<details>
<summary>为什么统一后，圆形和方形仍可能看起来不一样大？</summary>

当前算法统一的是**主体最长边占画布的比例**，不保证所有形状拥有相同的视觉面积或视觉重量。已有底板图标的内部留白也会保留。

图中两排使用相同大小的画布。ChatGPT、Cursor 放大，Discord、Firefox 缩小；Telegram、Chrome 已在容差范围内，保持原样。图中的应用图标与商标归各自权利人所有，不表示第三方认可或背书。

</details>

## 功能

<table>
<tr>
<td width="50%" valign="top"><strong>图标归一化</strong><br>调整主体占比，按需补充底板（含圆角底板），生成 16–512 px 九档图标。</td>
<td width="50%" valign="top"><strong>自定义方案</strong><br>调整目标、容差和内层参数，保存最多 50 套命名方案。</td>
</tr>
<tr>
<td valign="top"><strong>逐应用管理</strong><br>搜索、筛选、查看对比预览，为单个图标设置跳过或分类规则。</td>
<td valign="top"><strong>自动维护与主题跟随</strong><br>检测应用入口变化；更换素材主题时保留参数与逐图标规则。</td>
</tr>
<tr>
<td valign="top"><strong>规则状态可见可修</strong><br>每个图标标注分类来源（自动 / 用户规则 / 已复核）；规则失效时告警并可一键重置，跨尺寸目录自动接续。</td>
<td valign="top"><strong>并发安全与防冻结</strong><br>跨进程 flock 互斥 + 事务日志安全回滚；批量渲染按 idle 时间片切片，桌面不冻结。</td>
</tr>
<tr>
<td valign="top"><strong>健康诊断与安全恢复</strong><br>显示故障与中英文详情；还原托管修改，遇到外部编辑时停止覆盖。</td>
<td valign="top"><strong>自适应中英文界面</strong><br>适配宽窄窗口，即时切换语言并保留页面、搜索与未保存草稿。</td>
</tr>
</table>

## 快速开始

需要 GNOME Shell 51、系统 Python（含 Pillow、NumPy、PyGObject/GTK 3）和 systemd 用户会话。

```bash
python3 tools/install.py
```

从旧的进程内 GJS 版迁移时，先停用 Icon Normalizer。安装后注销再登录，然后启用扩展。当前版本见 [1.3.10 说明](docs/RELEASE-1.3.10.md)。

## 使用说明

| 页面 | 可以做什么 |
| --- | --- |
| **规则** | 调整参数、选择预设或命名方案；查看并编辑逐图标规则（改类别 / 重置为自动） |
| **应用图标** | 搜索、筛选（含“有规则”）、查看原始与候选预览，管理逐图标跳过规则 |
| **维护** | 查看状态、立即检查或应用并激活主题，设置自动维护、主题跟随、语言与顶栏按钮 |

**建议顺序：查看预览 → 调整参数 → 保存并应用。** 标准预设为 **88% / ±2 个百分点 / 72%**，输出尺寸为 `16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 px`。

<details>
<summary>自定义方案怎样生效？</summary>

“保存为自定义方案”存储当前参数；“使用方案”只填入草稿。点击“仅保存”或“保存并应用”后，参数才成为生效配置。命名方案不绑定图标主题。

</details>

<details>
<summary>换主题、新装应用或关闭窗口后会怎样？</summary>

「维护 → 跟随图标主题」默认开启。首次应用后，只要自动维护和主题跟随都开启，切换到任意已安装的图标主题都会使用它重新生成并激活 `DockNormalized`，保留参数与逐图标规则。登录时也会同步当前主题。要使用原样图标，可以关闭跟随再切换主题，或选择「恢复原样」；还原后手动应用即可恢复维护。

扩展启用时，标准 Yaru GTK 主题跟随系统深浅色和强调色，自定义 GTK 主题保持手动选择。`DockNormalized` 激活且主题跟随开启时，标准 Yaru 图标来源也跟随强调色与深浅色，只选择已安装变体。

自动维护通过 systemd 监视应用入口变化，另有 1 小时检查兜底。Python 进程按需启动，任务结束后退出。

</details>

<details>
<summary>应用换了图标，我之前设的规则失效了怎么办？</summary>

规则按源图指纹绑定。应用更新图标后指纹变化，规则会失效并退回自动分类 —— 这件事**不静默**：

- 维护页顶部出现“检测到 N 条图标规则已失效”提示，可逐条查看并**一键重置为自动**；
- 顶栏指示器（开启时）发送一次桌面通知，可在“维护 → 规则失效时通知我”关闭，同一问题不会重复提醒；
- 只是换尺寸目录的情况会自动按文件名接续，无需处理；
- 满幅直角底板可改为 `plate-rounded`（预览弹窗会给出建议）。

命令行排查：`status` 的 `rules_health`、`doctor` 的 `checks.rules`，详见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

</details>

<details>
<summary>界面语言和顶栏入口在哪里？</summary>

在“维护 → 界面语言”选择“跟随系统”“简体中文”或“English”。顶栏与设置共用语言偏好，切换后即时更新。

顶栏按钮默认关闭。在“维护 → 显示顶栏按钮”开启后，可通过单色图标查看状态、检查或应用图标，以及打开设置。

</details>

## 兼容与依赖

仅声明经过运行时验收的 **GNOME Shell 51**；其他版本需要单独验证。

| 组件 | 依赖 |
| --- | --- |
| 扩展（顶栏与设置） | GNOME 51、GJS、GTK 4 / Libadwaita |
| 设置窗口 | GTK 4、Libadwaita 及对应 GI 类型库 |
| 渲染及自动维护 | Python 3.10+、Pillow、NumPy、PyGObject / GTK 3、systemd 用户会话 |
| 构建与安装 | `gtk-update-icon-cache`、`glib-compile-schemas` |

- 托盘、AppIndicator，以及应用直接绘制或从文件加载的窗口图标，可能绕过图标主题。
- 非默认 `XDG_DATA_HOME` 暂不支持，安装检查会拒绝该环境。
- GitHub 下载与本地安装不代表 GNOME 商店审核通过；审核范围见[提交说明](docs/SUBMISSION.md)。

## 质量与安全

- **21 道质量门**一条命令全量回归（`bash tools/verify.sh`）：后端 261 项测试、前端 5 组套件、**GJS 参考引擎单测**、**UI 载荷契约测试**（Q20：界面每个调用的操作都必须有用界面真实载荷编写的用例，防止实现与测试互相印证地一起错）、**144 组渲染 + 69 组分析**的 GJS vs Python 跨实现逐像素对拍。
- **无网络、无遥测**：全仓不含任何网络请求代码；发布物为可读 GJS/SVG/CSS，无二进制、无压缩混淆。
- **隐私审计**：`tools/privacy_audit.py` 对全仓 `git` 跟踪文件及发行包成员做默认拒绝模式扫描（密钥、个人路径、邮箱、图片元数据、tar 头账号信息），0 发现。
- **构建可复现**：固定时间戳与权限的构建脚本，两次构建与发布资产逐字节一致。

## 恢复与卸载

在“维护 → 还原桌面图标”点击“还原”并确认，可恢复托管修改与最近选择的素材主题。未被外部编辑的托管启动器按原始字节还原；发生冲突时保留外部修改并报告失败。

在完整发行包或源码目录执行：

```bash
# 先恢复托管修改，再卸载扩展与后台。
python3 tools/uninstall.py

# 仅移除扩展，保留后台与自动维护。
python3 tools/uninstall.py --keep-backend
```

备份保留在 `~/.local/state/icon-normalizer/backups/`。恢复失败时保留状态文件与托管目录，按[验收与恢复说明](docs/CHECKLIST.md)处理。

## 开发文档

| 文档 | 内容 |
| --- | --- |
| [架构说明](ARCHITECTURE.md) | 模块职责、进程隔离、事务与数据流 |
| [ADR-0008](docs/adr/0008-gjs-only-engine.md) | 纯 GJS 引擎与 1.3.8 切回独立 Python 后台的演进决策 |
| [协议规范](PROTOCOL.md) | JSON 请求、错误码与并发控制 |
| [贡献指南](CONTRIBUTING.md) | 开发检查、反馈要求与双语写作规范 |
| [发布验收](docs/CHECKLIST.md) | 自动检查、桌面验收与恢复步骤 |
| [版本记录](CHANGELOG.md) | 历史版本；[v1.3.10 说明](docs/RELEASE-1.3.10.md) |

更多资料见[文档索引](docs/README.md)。报告问题时，请附系统与组件版本、复现步骤，并先去除日志或截图中的私人信息。

## 作者

由 **[TengJoe](https://github.com/TengJoe)** 开发，使用 [GPL-3.0-or-later](LICENSE) 许可证。所有功能均可免费使用。

[反馈问题](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [贡献代码](CONTRIBUTING.md)
