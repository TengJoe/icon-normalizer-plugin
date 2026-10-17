# Icon Normalizer v1.1.5

发布于 2026-10-17。扩展 **1.1.5**，后台 **3.1.4**，实测支持 **GNOME Shell 51**。API 1 和渲染核心版本 2 保持。

[GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.5) · [English](#english)

## 行为范围

- 扩展启用时监听 GNOME 深浅色、强调色和图标主题。将 Ubuntu 的 `default` 明确为 `prefer-light`，解决本机 Codex 从深色返回浅色时未收到明确浅色偏好的兼容问题。应用仍需设置为跟随系统。
- GTK 同步仅管理标准 Yaru 系列，按 GNOME 强调色与深浅色选择已安装 GTK 3 主题；自定义 GTK 家族不被替换。它不修改应用自己的主题设置。
- `DockNormalized` 激活且图标跟随、自动维护已开启时，后台将标准 Yaru 来源迁移到对应的已安装强调色/深浅色版本。其他图标家族仅保留原有同族深浅色配对。
- 缺失或未知强调色不会强行选择未安装主题；原始系统资源只读。策略、baseline、生成文件仍走同一事务和所有权校验。
- 停用扩展会移除 GTK 监听，不回写旧颜色；systemd 图标维护状态不变。重新启用时对齐当前系统状态。

## 下载与升级

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.5.tar.gz` | 完整安装或升级，含扩展、后台与安装工具 |
| `icon-normalizer@joeydeng.local.zip` | 仅扩展前端 |
| `DIST_MANIFEST.json` | 组件版本与安装包 SHA-256 |
| `SHA256SUMS` | 两个安装包和 manifest 的完整性校验 |

完整的强调色图标联动需要后台 3.1.4，请使用完整包一并升级。准备 [README](../README.md#兼容与依赖) 中的依赖，把完整包与 `SHA256SUMS` 放在同一目录，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验为 OK 后继续：
tar -xzf icon-normalizer-plugin-1.1.5.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

安装器保留安装快照和既有 timer/path 状态。正在运行的 GNOME Shell 可能缓存旧 JS 模块；保存工作并注销、重新登录后加载新前端。后台按请求启动，升级后即使用新代码。安装器不会自动结束桌面会话。

## 验证与恢复

- 190 项后台测试、22 项安装与打包测试、13 组前端生命周期检查通过；Python 类型检查覆盖 27 个模块。
- 真实 GJS 测试通过，独立 D-Bus/dconf 会话完成三轮跨进程深浅色和强调色切换。
- 隔离 GNOME Shell 51 完成两轮颜色切换、自定义 GTK 主题保护，以及停用/重新启用验证。
- 本机完成紫色浅色、紫色深色、紫色浅色、蓝色浅色四步验证；Portal 深色值为 1，浅色值为 2；593 个受管理目标哈希匹配，无待恢复事务。
- ZIP 和完整源码包与源码逐文件一致，构建或核验失败时保留旧安装包。

图标迁移保留事务回滚、所有权校验和最新主题选择保护。安装器升级失败时恢复安装快照；还原图标与卸载说明见 [README](../README.md#恢复与卸载)。公开商店审核、其他 GNOME 版本及 Codex 窗口的独立视觉验收不在本轮验证范围。

## English

Released on 2026-10-17: extension **1.1.5**, backend **3.1.4**, tested on **GNOME Shell 51**. Standard Yaru GTK and icon variants follow GNOME accent and color-scheme preferences when installed. Custom GTK and icon families keep their selected colors. The Shell promotes Ubuntu's `default` preference to explicit `prefer-light`; applications must use their system theme option.

Icon migrations retain transactional updates, ownership checks and activation guards. Disabling the extension disconnects GTK listeners without restoring an older preference or changing background maintenance. The installer preserves snapshots and trigger states. Cached Shell modules may require the next login; the separately launched backend uses upgraded code immediately. Both ZIP and full source archives are checked byte-for-byte against current source before replacing existing build artifacts.

Use the complete `icon-normalizer-plugin-1.1.5.tar.gz` package to upgrade both components. Download it alongside `SHA256SUMS`, verify with `sha256sum --ignore-missing -c SHA256SUMS`, extract, and run `python3 tools/install.py` as your regular user. The ZIP contains the frontend only. `DIST_MANIFEST.json` records component versions and package hashes.

Validation: 190 backend tests, 22 installation/build tests, 13 frontend lifecycle groups, three private dconf cycles, two isolated GNOME Shell color cycles, and a live desktop cycle with matching hashes for 593 managed targets. GNOME Extensions review, other Shell versions and independent visual acceptance of the Codex window are outside this verification scope.
