# 1.3.8 本地版

GNOME 扩展只负责界面和主题事件。Python 3.1.21 按需启动，后台例行检查使用 2 个线程省电，手动应用恢复最多 4 线程（`min(4, cpu_count)`），复用已有图标、配置与逐图标规则。应用目录变化由 systemd path 触发，另有每小时一次的增量兜底检查。

从 GNOME「优化」选择图标主题后，新主题成为来源，生成成功后激活 DockNormalized。登录时恢复跟随，渲染期间的新选择优先；锁屏解锁且外观未变化时跳过无用的后台检查。关闭跟随可以使用原始图标主题，「恢复原样」会停止自动维护。

本地升级前停用旧扩展，避免仍在会话中的 GJS 写入文件。安装器在写入锁内备份代码、设置和渲染器归属，验证失败时恢复，成功后仅保留最近 2 份安装快照。

## 本版修复

- **设置页「逐图标规则」恢复显示并消除 GTK 警告**：`rulesPage.js` 补上 `this._ruleGroup.add(row)`，不再漏挂 `AdwActionRow` 并消除刷新时的 4 条 `Adwaita-CRITICAL: tried to remove non-child` 报错。
- **旧格式/无 SHA 用户规则对账**：`control.py` `_rows_to_groups` 与 `op_rules_set`（及 GJS `control.js`）改为与引擎一致的 `lookup_rule_ex` 查找和遗留键清理，按原始路径保存且未写 `source_sha256` 的规则不再在 `scan` 里被隐藏为 `automatic`，点击重置也能正确清除。
- **测试提速**：`tests/gjs/control.test.js` 与 `uicontract.test.js` 隔离夹具应用目录，不再扫描本机 85 个真实应用（`control.test.js` 由 >5 分钟降到 ~2.6 秒，`uicontract.test.js` ~0.4 秒）。

仓库保留 21 道开发质量门。版本用于本机安装。
