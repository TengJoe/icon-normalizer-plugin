# Icon Normalizer v1.1.7

发布于 2026-10-28。扩展 **1.1.7**，后台 **3.1.5**，实测支持 **GNOME Shell 51**。API 1 与渲染核心版本 2 保持不变。

[GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.7) · [English](#english)

## 本次修复

- **主题激活不再被静默跳过**：应用操作现在会返回明确的激活结果（`applied` / `unavailable` / `superseded`）与 `theme_active`。此前后台在 GSettings 不可用、或用户在事务执行期间切换了其他图标主题时，会照样报告成功，而桌面仍显示原始图标。
- **设置页按钮名实相符**：原「立即应用」只渲染文件、不切换图标主题，与顶栏同名操作行为不一致。现改为「仅重新渲染」，并提供「应用并激活」作为主操作。
- **未激活状态可见**：维护页顶部常驻提示（附「立即激活」按钮），激活失败以错误样式显示，不再出现"完成"却毫无变化的情况。
- **安装与升级**：安装器在完成后探测图标主题，升级前已激活的主题会被恢复；仍未激活时输出下一步命令。

## 其他变更

- 前端按 `shell` / `prefs` / `shared` 明确进程边界；设置与预览窗口使用可取消的请求作用域，关闭后停止读取与后续步骤，已开始的写入安全完成。
- 复用、清理、还原与事务提交使用检查时记录的前置哈希；晚到的外部修改返回 `OWNERSHIP_CONFLICT`，不自动采纳新哈希或覆盖文件（[ADR-0007](adr/0007-ownership-preconditions.md)）。
- 后台失败保留首次发生时间与次数，完整维护成功后解除；普通输入错误不进入持久健康记录。
- 移除捐赠元数据、收款码、设置入口与 Sponsor 配置；清理无用导出和旧版 GNOME 回退。
- 加入固定版本 ESLint 与真实 GTK 关闭中请求回归。

## 下载与升级

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.7.tar.gz` | 完整安装或升级，含扩展、后台与安装工具 |
| `icon-normalizer@joeydeng.local.zip` | 仅扩展前端 |
| `DIST_MANIFEST.json` | 组件版本与安装包 SHA-256 |
| `SHA256SUMS` | 两个安装包与 manifest 的完整性校验 |

准备 [README](../README.md#兼容与依赖) 中的依赖，把完整包与 `SHA256SUMS` 放在同一目录，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验为 OK 后继续：
tar -xzf icon-normalizer-plugin-1.1.7.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

安装器保留安装快照与既有 timer/path 状态，升级失败时回滚。正在运行的 GNOME Shell 可能缓存旧 JS 模块，保存工作并注销、重新登录后加载新前端；后台按请求启动，升级后即使用新代码。

## 验证与恢复

- 211 项后台测试（含 74 项子测试）、22 项安装与打包测试通过。
- 前端 13 组应用流、13 组指示器、14 组状态模型、5 组 i18n 检查通过；`eslint` 零警告，语法检查覆盖全部前端模块。
- ZIP 与完整源码包构建后与源码逐文件一致（`matches_source: true`），发布审计无警告。
- 本机完成一次真实升级：`install.py` 探活通过，`DockNormalized` 保持激活（`theme_active: true`），触发器状态恢复。
- 图标迁移仍保留事务回滚、所有权校验与最新主题选择保护；还原图标与卸载说明见 [README](../README.md#恢复与卸载)。

本次修复针对"文件已应用、主题未激活"的状态回报与入口语义。公开商店审核、其他 GNOME 版本与独立视觉验收不在本轮验证范围内。

## English

Released on 2026-10-28: extension **1.1.7**, backend **3.1.5**, tested on **GNOME Shell 51**. API 1 and render core 2 are unchanged.

**Theme activation is no longer silent.** Apply now reports an explicit activation outcome (`applied` / `unavailable` / `superseded`) plus `theme_active`. Previously the backend reported success while the desktop kept the original icons whenever GSettings was unavailable or the user switched to another icon theme mid-transaction.

The preferences action that only rendered files was renamed from "Apply now" to "Re-render only", the maintenance page gained a persistent inactive-theme banner with an "Activate now" action, and failed activation is shown as an error instead of "done". The installer probes the icon theme after install, restores a theme that was active before an upgrade, and prints the next step when it is still inactive.

Also in this release: explicit `shell` / `prefs` / `shared` process boundaries with cancellable request scopes, recorded-hash ownership preconditions returning `OWNERSHIP_CONFLICT` on late external edits ([ADR-0007](adr/0007-ownership-preconditions.md)), persisted backend health with first-seen time and failure count, removal of donation assets, and a pinned ESLint setup with real GTK regression coverage.

Use the complete `icon-normalizer-plugin-1.1.7.tar.gz` package to install or upgrade both components. Download it alongside `SHA256SUMS`, verify with `sha256sum --ignore-missing -c SHA256SUMS`, extract, and run `python3 tools/install.py` as your regular user. The ZIP contains the frontend only.

Validation: 211 backend tests (74 subtests), 22 installation/build tests, 13 + 13 + 14 + 5 frontend groups, zero ESLint warnings, and byte-for-byte archive verification against source. A real upgrade on the maintainer's desktop kept `DockNormalized` active (`theme_active: true`) and restored trigger states. GNOME Extensions review, other Shell versions and independent visual acceptance remain outside this scope.
