# Icon Normalizer v1.1.2

发布于 2026-10-14。扩展 **1.1.2**，配套后台 **3.1.1**，实测支持 **GNOME Shell 51**。

[简体中文](#简体中文) · [English](#english) · [GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.2)

## 简体中文

### 本次更新

- 逐图标跳过和手动分类按协议图标 ID 正确参与应用，升级时识别受旧问题影响的分类缓存。
- 预览校验当前素材与来源主题，素材更新、删除或主题切换后要求刷新；预期刷新错误不再污染持久健康状态。
- 预览使用当前草稿参数与规则重新计算，并从正确的素材主题读取相应尺寸的原图。
- 状态同时比较参数与规则版本，修改规则后正确提示尚未应用。
- 保留紧凑心跳与按需写入明细、正常锁竞争跳过，以及安装快照数量限制。
- 完整包补齐贡献指南；扩展 ZIP 不附带编译后的 GSettings schema，本地安装器会自动编译。
- 重排中英文首页，展示真实应用 PNG 对比、清晰的下载入口和折叠使用说明。

视觉分析与渲染算法、API v1 和渲染内核版本保持不变。当前归一化统一主体最长边占比，不保证圆形、方形或不同内部留白的图标具有相同视觉重量。

### 下载与升级

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.2.tar.gz` | 完整安装或升级，包含扩展、已修复后台与安装器 |
| `icon-normalizer@joeydeng.local.zip` | 仅前端，不包含已修复的 Python 后台 |
| `DIST_MANIFEST.json` | 组件版本与包 SHA-256 |
| `SHA256SUMS` | 下载完整性校验 |

要获得本次后台修复，请使用完整发行包。准备 [README](../README.md#兼容与依赖) 中的依赖，将 tar.gz 与 `SHA256SUMS` 放在同一目录，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验显示 OK 后，继续：
tar -xzf icon-normalizer-plugin-1.1.2.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

升级器保留已有参数、规则和自动维护状态，并在探活失败时恢复快照。本轮前端 JavaScript 内容未变；关闭后重开设置窗口可刷新版本显示，后台修复无需注销桌面。本次未改写历史 v1.1.1 标签或附件。

### 验证与范围

- 后台全量回归：160 项；安装与故障回滚：19 项；严格类型检查：23 文件。
- 修复代码此前在已安装后台上通过 11 项隔离行为回归，真实系统 32/48/128px 预览和正常维护通过。
- 发行构建包含严格 schema 编译、ZIP 与源码一致性、源码包检查与隐私扫描。
- 本次未重跑完整真实 GTK 交互及 GNOME Shell 锁屏/解锁矩阵，不将这些项目记为新版通过。

GitHub 发布不代表 GNOME Extensions 审核通过。托盘与应用自行绘制的图标可能绕过主题；非默认 `XDG_DATA_HOME` 暂不支持。所有功能免费，支持开发完全自愿，见[支持页面](SUPPORT.md)。

## English

Extension **1.1.2**, companion backend **3.1.1**, verified **GNOME Shell 51**.

### Changes

- Apply per-icon skip and manual classification rules using protocol icon IDs, and invalidate affected legacy classification caches.
- Check the current source artwork and theme before preview cache use. Updated or missing artwork requires a refresh without persisting a health failure.
- Recompute previews from current draft settings and rules, and resolve original artwork at the requested size in the correct source theme.
- Compare applied settings and rule revisions so unapplied rule changes are reported correctly.
- Retain compact heartbeat records, detail writes only on change, normal lock-contention skips, and bounded installation snapshots.
- Include the contribution guide in complete packages. Extension ZIPs omit compiled GSettings schemas; the local installer compiles them.
- Redesign the bilingual homepage with real PNG comparisons, clear downloads, and folded guidance.

Analyzer and renderer math, API v1, and the render-core version remain unchanged. Normalization aligns longest-edge coverage, rather than guaranteeing equal perceptual weight across shapes or internal padding.

### Download and upgrade

| Asset | Purpose |
| --- | --- |
| `icon-normalizer-plugin-1.1.2.tar.gz` | Complete installation or upgrade, including the fixed backend |
| `icon-normalizer@joeydeng.local.zip` | Frontend only; does not contain the fixed Python backend |
| `DIST_MANIFEST.json` | Component versions and package SHA-256 hashes |
| `SHA256SUMS` | Download integrity checks |

Use the complete package to obtain these backend fixes. Prepare the [runtime dependencies](../README.en.md#compatibility-and-dependencies), put the tarball and `SHA256SUMS` in the same directory, and run as your normal user:

```bash
sha256sum --ignore-missing -c SHA256SUMS
# Confirm that verification reports OK, then continue:
tar -xzf icon-normalizer-plugin-1.1.2.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

The upgrader preserves settings, rules, and maintenance state, and restores its snapshot if the status probe fails. Frontend JavaScript is unchanged in this release; close and reopen Preferences to refresh displayed version metadata. Backend fixes do not require logging out. The historical v1.1.1 tag and assets are preserved.

### Validation and scope

- 160 backend tests, 19 installation and rollback tests, and strict type checking of 23 source files.
- The fixed installed backend previously passed 11 isolated behavior regressions; real 32/48/128px previews and normal maintenance passed.
- Release gates include strict schema compilation, source/ZIP consistency, complete-package checks, and privacy scanning.
- The full real GTK interaction and GNOME Shell lock/unlock matrix was not rerun for this release and is not claimed as newly passed.

GitHub publication does not imply GNOME Extensions approval. Tray icons and artwork drawn by applications may bypass icon themes; non-default `XDG_DATA_HOME` remains unsupported. All features are free; optional support is documented on the project repository.
