# Icon Normalizer v1.1.14

发布日期：2026-11-06。扩展 **1.1.14**、配套后台 **3.1.12**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 背景

`overrides.json` 中的 reviewed override 按源图指纹（`source_sha256`）绑定。应用更新图标后指纹变化，覆盖规则静默失效、图标退回自动分类 —— 这正是 DeepSeek 图标退化为"尖角白方块"的根因。此前没有任何提示。

## 本次修复

- 每次运行时检查所有已配置的覆盖规则：若对应源图存在但指纹不匹配，写入 `rule_warnings`（`error = OVERRIDE_STALE_SOURCE`，附 `expected_sha256` / `actual_sha256`）。
- 维护页据此显示常驻告警（1.1.13 起支持）。
- 随包发布、图标未安装的 portable 条目不产生警告，避免噪音。

## 验证

- 全量后端测试 **247 项通过**（新增 2 项）。
