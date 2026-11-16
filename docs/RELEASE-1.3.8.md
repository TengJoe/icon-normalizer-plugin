# Icon Normalizer v1.3.8

发布日期：2026-11-17。扩展 **1.3.8**、配套后台 **3.1.21**（渲染核心 3），支持范围为 **GNOME Shell 51**。

## 变更要点

- **独立 Python 3.1.21 按需后台**：Shell 扩展仅保留面板、主题事件与设置 UI；后台定时检查保持 **2 线程** 省电，手动应用恢复最多 **4 线程**（`min(4, cpu_count)`）。应用目录变化由 systemd path 触发，另有每 **1 小时** 一次的增量兜底检查。
- **主题跟随与锁屏解锁优化**：从 GNOME「优化」或设置切换任意已安装图标主题后，保留规则并自动激活 `DockNormalized`；锁屏解锁时若 `DockNormalized` 仍激活且外观（`color-scheme` / `accent-color`）未变，跳过无用的后台同步。
- **快照保留精简**：本地安装/升级验证通过后仅保留最近 **2 份** `install-snapshot-*` 备份，失败仍自动回滚全部代码、单元与归属状态。

## 修复内容

- **设置页「逐图标规则」恢复可见且消除 GTK 警告**：`extension/prefs/rulesPage.js` 补上 `this._ruleGroup.add(row)`，修复逐图标规则行未挂载的问题，并消除刷新设置页时的 4 条 `Adwaita-CRITICAL: tried to remove non-child` 报错。
- **旧格式/无 SHA 用户规则对账与重置**：`backend/icon_normalizer/control.py`（及 `extension/lib/control.js`）在 `scan` 与 `rules.set` 中对齐 `lookup_rule_ex`，按原始路径保存且未写 `source_sha256` 的用户规则不再被标成 `automatic`，重置时同步清理遗留键。
- **GJS 单测提速 120 倍**：`tests/gjs/control.test.js`（~2.6s，18 项）与 `uicontract.test.js`（~0.4s，9 项）隔离夹具应用目录，不再每条用例重扫本机 85 个桌面应用。

## 验证

- **21 道质量门**全部通过（`bash tools/verify.sh`：`21/21 PASS`、`0 failed`、`0 skipped`）。

---

### English summary

- **On-demand Python 3.1.21 worker**: Shell extension stays thin (panel, theme events, preferences). Scheduled runs use 2 worker threads; manual applies use `min(4, cpu_count)` threads; systemd path watches launcher directories with a 1-hour fallback timer.
- **Theme follow & unlock fast-path**: switching to an installed icon theme rebuilds and activates `DockNormalized`; unlocking the screen skips redundant `theme.sync` calls when appearance and active overlay have not changed. Installer retains the latest 2 snapshots.
- **Fixes**: fixed missing `this._ruleGroup.add(row)` in `rulesPage.js` (restoring the per-icon rules list and eliminating 4 `Adwaita-CRITICAL` warnings on refresh), aligned legacy/SHA-less user-rule lookup and reset in `control.py`/`control.js`, and isolated GJS fixture `applicationDirs` (`control.test.js` >5 min -> 2.6 s).
- **Verification**: all **21 quality gates** pass (`bash tools/verify.sh`).
