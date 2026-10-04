# Icon Normalizer Plugin

[English guide](README.en.md)

[下载 v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1) ·
[问题反馈](https://github.com/TengJoe/icon-normalizer-plugin/issues) ·
[支持开发](docs/SUPPORT.md)

面向 Linux / GNOME 桌面的应用图标归一化插件与用户级后台维护服务。
解决第三方应用图标“忽大忽小、留白杂乱、形状不一”的痛点，提供类似 macOS
的视觉一致性。系统素材保持只读，改动落在用户目录并保留恢复记录。

- 目标占比 **88%**（Ubuntu/Yaru 原生图标统计中位数）、死区 **±2%**（死区内不重采样）、
  裸 Logo 内层 **72%**（0.88 × 0.72 ≈ 63.4%）、九档固定尺寸梯队
  `16/24/32/48/64/96/128/256/512`。
- 只写入 `~/.local/share/icons/DockNormalized/`（`Inherits=<原生主题>,hicolor`）
  与必要时的用户级启动器覆盖层，并维护用户级状态、预览缓存和服务单元。
  未被外部编辑的托管启动器按原始字节还原；冲突时保留外部编辑并报告失败。
- 后端（Gtk3/GdkPixbuf）与前端（Gtk4/Libadwaita）**绝对进程隔离**，仅以
  单行 JSON CLI 协议通信（见 `PROTOCOL.md`）。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| 后端包 | `backend/icon_normalizer/` | 归一化引擎（engine/analyzer/renderer/transaction）、协议控制器、预览缓存、systemd 适配 |
| 扩展 | `extension/` | GNOME 51（本版实测范围）；面板指示器（默认关）+ 三页设置窗口 |
| 契约 | `contracts/` | 协议 v1 JSON Schema（冻结） |
| 工具 | `tools/` | 构建 / 安装 / 卸载（布局唯一事实源 `layout.py`） |
| 单元 | `packaging/systemd/` | `service`（oneshot+沙箱）、`timer`（每分钟兜底）、`path`（入口目录秒级触发） |
| 测试 | `tests/` | 后端/事务恢复、安装故障、前端逻辑、真实 GJS/GTK4 回归，全部使用独立 fixture |

## 构建与安装

首次安装请从 [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1)
下载完整安装包 `icon-normalizer-plugin-1.1.1.tar.gz` 与 `SHA256SUMS`。
在 GNOME Shell 51 环境准备好下方运行依赖后，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

Release 中的扩展 ZIP 用于已有配套后台的前端安装/升级，也作为 GNOME Extensions
的提交包。ZIP 不包含 Python 后台，首次完整安装请使用上面的 tar.gz。

从源码开发或构建时，在项目根目录执行：

```bash
# 构建（严格 schema 编译 → 扩展 ZIP + 发行 tarball + DIST_MANIFEST）
python3 tools/build.py

# 安装 / 升级（快照 → 原子换装 → 探活；失败自动回滚）
python3 tools/install.py

# 卸载（先经后端 revert 字节级还原桌面；--keep-backend 仅移除面板）
python3 tools/uninstall.py
python3 tools/uninstall.py --keep-backend
```

运行依赖（precheck 自动诊断）：`python3 (≥3.10)`、`python3-gi + gir1.2-gtk-3.0`、
`python3-pil`、`python3-numpy`、`gtk-update-icon-cache`。

## 使用

- 设置入口：扩展管理器 → **图标统一** → 设置（规则 / 应用图标 / 维护 三页）。
- 顶栏指示器默认关闭；在“维护”页打开开关即时生效。
- 顶栏使用单色图标；菜单按运行摘要、主题/最近应用与操作分组显示。
- “维护 → 界面语言”提供跟随系统、简体中文、English 三种选择；切换即时生效，
  保留当前页面、搜索条件及未保存参数。顶栏与设置共用语言偏好。
- 后台维护完全独立：`systemctl --user` 驱动的 `icon-normalizer.timer`
  （每分钟兜底）与 `icon-normalizer.path`（监听用户/系统/Flatpak 入口目录，
  新装应用秒级归一化）。锁屏或关闭设置窗口不影响后台。
- “维护”页提供 **立即检查 / 立即应用 / 应用并激活主题 / 完全还原** 通道；
  还原前有确认对话框。

## 开发

```bash
# 后端：类型门 + 全量单测
~/.local/bin/mypy                                        # strict，22 文件
python3 -m unittest discover -s tests/backend -p 'test_*.py'

# 前端：语法门 + 纯逻辑单测
node tests/frontend/syntax-check.mjs
node tests/frontend/stateModel.test.mjs

# 安装回归（私有文件树与假 systemd 管理器）
python3 -m unittest discover -s tests/installation -p 'test_*.py'

# 真实 GNOME 51 设置加载与预览（需要图形会话，后端仍为独立 fixture）
python3 tests/frontend/test_runtime.py
```

架构基准见 `ARCHITECTURE.md`；协议细节见 `PROTOCOL.md`；
决策记录见 `docs/adr/`；发布验收清单见 `docs/CHECKLIST.md`。

## 已知边界

- 托盘/AppIndicator 图标（Vitals、剪贴板指示器等）由运行中的应用自行绘制，
  绕过图标主题，无法归一化（协议标记 `unsupported`）。
- 以 `set_icon_from_file()` 设置窗口图标的少量应用同样绕过主题——覆盖率“高”而非 100%。
- 非默认 `XDG_DATA_HOME` 会被 precheck 拒绝（v1 明确不支持）。
- 尚未提交 extensions.gnome.org；配套后台单独安装，外部进程边界需向审核者说明，详见 SUBMISSION.md。
- metadata 只声明实测 GNOME 51；更早版本需完成各自运行时验收后再扩展声明。
- 升级后新设置窗口进程会加载新代码；已运行的 Shell 缓存扩展模块，面板代码更新
  需要保存工作后注销并重新登录。安装器不会自动结束图形会话。

## 自定义方案与更换图标主题

规则页可将当前视觉参数另存为命名方案、使用、重命名或删除，最多 50 套。
“使用方案”只填入参数，点击“仅保存”或“保存并应用”后才生效；方案可用于不同图标主题。
维护页的“跟随图标主题”默认开启：自动维护开启时，更换已安装的图标主题会保留
视觉参数并重新生成 DockNormalized。关闭设置窗口后仍由 timer 每分钟兜底。
更换 GTK/Shell 外观主题不修改视觉参数；重新选择原素材主题不会强制激活覆盖层。
“完全还原”恢复最近选择的素材主题。迁移失败会保留原有配置、图标与还原记录。

本版前端 **1.1.1**、后端 **3.1.0**，上架候选只声明实测 **GNOME 51**。
发布准备和配套服务审核说明见 [SUBMISSION.md](docs/SUBMISSION.md)。
源码许可证为 GPL-3.0-or-later，全文见 [LICENSE](LICENSE)。
公开源码与问题反馈见 [GitHub 项目](https://github.com/TengJoe/icon-normalizer-plugin)，
发行包见 [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1)。

## 作者与支持

作者：**[TengJoe](https://github.com/TengJoe)**。
设置窗口的「维护 → 关于与支持」提供项目主页、反馈入口、版本与许可证，
以及微信和支付宝收款码。所有功能均可免费使用，支持开发完全自愿。
详见 [支持说明 / Support](docs/SUPPORT.md)。
