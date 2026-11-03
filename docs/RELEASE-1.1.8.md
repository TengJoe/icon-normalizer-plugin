# Icon Normalizer v1.1.8

发布日期：2026-11-03。扩展 **1.1.8**、配套后台 **3.1.6**，支持范围为已测试的 **GNOME Shell 51**。API 版本仍为 1，渲染核心版本仍为 2。

[GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.8) · [English](#english)

## 本次修复

- **保留逐图标规则**：跳过或恢复图标时，只更新跳过状态，保留已有手动分类和素材指纹。旧版本已经覆盖掉的分类不能自动找回。
- **刷新预览**：切换跳过状态后重新加载对比图和处理说明，不再显示切换前的结果。
- **维护状态更准确**：过期响应不能覆盖较新的状态；读取失败时显示未知，而不是继续显示上一次的成功状态。
- **保留失败原因**：区分主题未激活、激活失败和无法确认；应用前的依赖检查错误不再被替换成笼统提示。
- **安装与测试**：快照分别记录安装器版本和备份中的后台版本；修正测试对 `XDG_DATA_HOME` 的默认路径假设，并同步 Python 项目版本信息。

## 下载与升级

下载 `icon-normalizer-plugin-1.1.8.tar.gz` 和 `SHA256SUMS` 到同一目录，确认 [运行依赖](../README.md#兼容与依赖) 后，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验为 OK 后继续：
tar -xzf icon-normalizer-plugin-1.1.8.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

完整包包含扩展、后台和安装工具。`icon-normalizer@joeydeng.local.zip` 仅包含扩展前端；安全跳过需要后台 **3.1.6 或更新版本**，旧后台会提示升级。安装器保留快照和已有自动维护状态；GNOME Shell 如仍缓存旧模块，保存工作后注销并重新登录。

本版扩展包不含捐赠配置或支付图片。GitHub 发布与 [GNOME 扩展网站审核](https://extensions.gnome.org/review/76404) 是独立流程，本次 GitHub 发布不表示官网已批准或更新旧审核包。

## 验证范围

- 后端 **220** 项、安装与回滚 **25** 项、前端逻辑 **54** 项通过；另有 **15** 项真实 GTK/隔离 GNOME 图形回归。
- 在隔离桌面使用已安装文件验证了 32/48 px 预览、规则保留以及主题激活成功和失败提示。
- 安装前后，生成图标、托管启动器与用户配置的校验一致；自动维护在真实桌面成功运行。当前 Shell 已报告扩展 1.1.8 处于启用状态。
- 真实桌面锁屏/解锁与完整手动界面矩阵未在本次发布中重新验收；其他 GNOME Shell 版本未声明支持。
- 后台 27 个源文件通过 mypy 严格检查；将检查扩展到发布工具目录时仍有 28 项与修复前相同的既有诊断。

还原与卸载说明见 [README](../README.md#恢复与卸载)。安装快照的版本字段说明见 [验收清单](CHECKLIST.md#5-发布产物)。

## English

Released on 2026-11-03: extension **1.1.8**, companion **3.1.6**, tested on **GNOME Shell 51**. Protocol version 1 and render core version 2 are unchanged.

Skipping or unskipping an icon now preserves its existing manual classification and source fingerprint. Previews and action descriptions refresh after the change. A classification already overwritten by an older release cannot be recovered automatically.

The maintenance page ignores outdated responses, shows unknown state when a refresh fails, and preserves dependency and theme-activation failures. Installation snapshots now distinguish the installer version from the backed-up backend version. Tests also cover custom `XDG_DATA_HOME` paths, and Python project metadata matches the backend version.

Use `icon-normalizer-plugin-1.1.8.tar.gz` and `SHA256SUMS` to install or upgrade both components as a regular user. The extension ZIP contains the frontend only. Safe skipping requires companion **3.1.6 or newer**; older companions show an upgrade hint. Save your work and log out and in if GNOME Shell has cached the previous modules.

Validation included 220 backend tests, 25 installation tests, 54 frontend logic checks and 15 isolated GNOME/GTK tests. The installed files were additionally exercised against an isolated backend and desktop. Real desktop lock/unlock and the entire manual UI matrix were not rerun for this release. The 27 backend source files pass strict mypy; 28 pre-existing diagnostics remain when extending strict checking to the release tools.

This release contains no donation metadata or payment images in its extension ZIP. GitHub publication does not imply approval on GNOME Extensions or removal of an older website archive; see the [review](https://extensions.gnome.org/review/76404).
