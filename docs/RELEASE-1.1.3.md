# Icon Normalizer v1.1.3

发布于 2026-10-15。扩展 **1.1.3**，配套后台 **3.1.2**，实测支持 **GNOME Shell 51**。

[简体中文](#简体中文) · [English](#english) · [GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.3)

## 简体中文

### 本次更新

- 状态与诊断入口不再预先导入图像处理模块。缺少 PIL、numpy 或 gi 时，仍可读取状态和诊断；图像操作返回明确的 `DEPENDENCY_MISSING`，未知程序异常不会被误判为缺依赖。
- 应用和还原统一返回 `OWNERSHIP_CONFLICT`，汇总外部修改的文件路径、图标名称、登记哈希和当前哈希。冲突清单最多返回 100 条，并提供总数；继续拒绝覆盖外部修改。
- 顶栏和维护页分别表达自动维护、后台健康与主题状态。即使旧主题仍生效，后台失败也会显示“维护受阻”；中英文只读详情展示冲突文件、首次和最近发生时间、连续失败次数。
- 相同故障保留首次时间，完整成功后才解除对应故障。维护与开关设置错误分开记录；保存配置、扫描成功和单独事务恢复不会提前清除维护故障。
- 健康记录使用 0600 权限和独立锁；事件历史最多 64 条，记录首次失败、原因变化和恢复，重复日志按次数汇总。
- 分开显示“最近检查成功”和“最近实际更新”。旧记录无法证明实际更新时间时显示暂无记录，下一次实际更新后建立准确时间。

保留 Python 后端与 GJS 前端；渲染公式、视觉参数、API v1、现有错误码、manifest/事务格式和自动维护触发频率保持不变。详见 [ADR-0006](adr/0006-reliability-boundaries.md)。

### 下载与升级

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.3.tar.gz` | 完整安装或升级，包含扩展、后台与安装工具 |
| `icon-normalizer@joeydeng.local.zip` | 仅扩展前端，不包含 Python 后台修复 |
| `DIST_MANIFEST.json` | 组件版本与包 SHA-256 |
| `SHA256SUMS` | 下载完整性校验 |

要获得完整可靠性修复，请使用完整发行包。准备 [README](../README.md#兼容与依赖) 中的运行依赖，将 tar.gz 与 `SHA256SUMS` 放在同一目录，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验显示 OK 后，继续：
tar -xzf icon-normalizer-plugin-1.1.3.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

升级器保留已有参数、规则与自动维护状态，并在探活失败时恢复快照。关闭后重开设置窗口以加载新版偏好界面；本次顶栏代码也有变化，当前 Shell 可能仍缓存旧模块，保存工作后注销并重新登录才能确认加载新版顶栏。安装器不会替你注销。

### 验证与范围

- 后端 178 项测试，其中新增可靠性回归 18 项；安装/卸载/回滚 19 项；mypy 严格检查 27 文件。
- 前端语法 17 文件；状态逻辑 14 项、顶栏 13 项、客户端 10 项、中英文 5 项。
- 真实 GTK 隔离窗口 10 项：包含中英文故障详情、恢复、自适应尺寸、预览、方案与草稿保留。
- 独立 GNOME Shell 51：真实顶栏 API、图标、双语、检查/应用、开关守卫和停启通过。独立会话的 HOME、状态与会话总线均隔离。
- 从后端 3.1.1 的九档夹具升级到 3.1.2：策略不过期，首次应用 0 文件操作，9 张 PNG 哈希与 manifest 字节不变。
- 严格 schema 构建、ZIP/源码一致性、发行包与隐私扫描通过。自适应测试改为等待实际绘制后采样，保留几何断言。

这些结果不等于新版已在维护者日常会话完成多日验证；本轮发布操作不替换维护者的真实安装，真实锁屏/解锁和多日使用仍待安装后验收。轻量模块存在性检查不证明所有 ABI/typelib 正常，完整检查使用 doctor。隐私模式扫描不证明绝无秘密。

GitHub 发布不代表 GNOME Extensions 审核通过，本轮未重新提交 GNOME 官网。冲突处理仍提供只读信息，不提供强制覆盖。所有功能免费，支持开发完全自愿，见[支持页面](SUPPORT.md)。

## English

Extension **1.1.3**, companion backend **3.1.2**, verified **GNOME Shell 51**. Published October 15, 2026.

### Changes

- Keep status and diagnostics available without importing the image-processing stack at startup. Missing PIL, numpy, or gi produces structured `DEPENDENCY_MISSING` errors for image operations; unrelated programming errors are not misclassified.
- Report `OWNERSHIP_CONFLICT` consistently during apply and revert, including paths, icon names, registered/current hashes, a total count, and up to 100 entries. External edits continue to block writes.
- Separate automation, backend health, and theme state in the panel and Preferences. Persisted faults display a blocked state even when the previous theme remains active. Bilingual, read-only details show conflicts, first/last occurrence times, and failure counts.
- Preserve the first occurrence of repeated faults and clear only the corresponding category after a complete successful operation. Saving configuration, successful scans, and transaction recovery alone cannot dismiss maintenance faults.
- Protect health receipts with 0600 permissions and a separate lock. Retain up to 64 compact failure/change/recovery events and summarize repeated log entries.
- Distinguish the last successful check from the last actual update. Legacy records without a provable update time display no update record until an actual output change establishes one.

The Python backend and GJS frontend remain in place. Rendering math, visual settings, API v1, existing error codes, manifest/transaction formats, and maintenance frequency are unchanged. See [ADR-0006](adr/0006-reliability-boundaries.md).

### Download and upgrade

| Asset | Purpose |
| --- | --- |
| `icon-normalizer-plugin-1.1.3.tar.gz` | Complete installation or upgrade, including the frontend, backend, and installer |
| `icon-normalizer@joeydeng.local.zip` | Frontend only; does not contain the Python backend fixes |
| `DIST_MANIFEST.json` | Component versions and package SHA-256 hashes |
| `SHA256SUMS` | Download integrity checks |

Use the complete package for all reliability fixes. Prepare the [runtime dependencies](../README.en.md#compatibility-and-dependencies), put the tarball and `SHA256SUMS` in the same directory, and run as your normal user:

```bash
sha256sum --ignore-missing -c SHA256SUMS
# Confirm that verification reports OK, then continue:
tar -xzf icon-normalizer-plugin-1.1.3.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

The upgrader preserves settings, rules, and maintenance state, and restores its snapshot if the status probe fails. Reopen Preferences to load its updated code. Panel code has also changed; the running Shell may cache the old modules, so save your work and log out/in to confirm the updated panel is loaded. The installer does not log you out.

### Validation and scope

- 178 backend tests, including 18 new reliability regressions; 19 installation/lifecycle tests; strict mypy checks for 27 files.
- Syntax checks for 17 frontend files; 14 state-model, 13 indicator, 10 client, and 5 bilingual tests.
- 10 real GTK fixture tests, including bilingual fault details/recovery, responsive layouts, previews, profiles, and draft preservation.
- An isolated GNOME Shell 51 session passed actual panel APIs, icon/language handling, check/apply, toggle guards, and disable/re-enable behavior. HOME, state, and the session bus were isolated.
- A nine-size fixture generated by backend 3.1.1 upgraded to 3.1.2 without a stale policy or file operations; all 9 PNG hashes and manifest bytes remained unchanged.
- Strict schema compilation, source/ZIP consistency, package checks, and privacy scanning passed. Responsive tests now wait for completed painting before measuring, retaining geometry assertions.

This publication does not replace the maintainer's live installation. Real daily-session lock/unlock and multi-day acceptance remain pending installation. Lightweight module discovery does not prove ABI/typelib health; use doctor for fuller checks. Pattern scanning cannot prove the absence of every secret.

GitHub publication does not imply GNOME Extensions approval; this release was not resubmitted there. Conflict details remain read-only, with no force-overwrite control. All features are free; support is voluntary and documented on the project repository.
