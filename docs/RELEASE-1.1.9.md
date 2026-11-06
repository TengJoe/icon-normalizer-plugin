# Icon Normalizer v1.1.9

发布日期：2026-11-06。扩展 **1.1.9**、配套后台 **3.1.7**，支持范围为已测试的 **GNOME Shell 51**。API 版本仍为 1，渲染核心版本仍为 2。

## 本次修复

- **规则失效不再静默**：过去手动规则的素材指纹（`source_sha256`）与源图不符时，解析器直接返回"无规则"，图标退回自动分类，且没有任何日志或提示。典型后果是应用更新图标后，精心配置的样式悄无声息地失效。
- 现在每条运行记录都带 `rule_state`：`active`（生效）、`stale_source`（指纹失配）、`unbound`（源图不可读）、`invalid`（类别非法）、`none`（未配置规则）。
- `last-run.json` 新增 `rule_warnings` 明细（含 `expected_sha256` / `actual_sha256`），`summary.rule_warnings` 提供计数。
- 应用成功后写入 `degraded` / `RULE_STALE` 健康事件。

## 兼容性

- `resolve_rule()` / `classify_source()` 的签名与返回值保持不变，旧调用方无需修改。
- 规则读取同时接受 `class` 与 `classification`，写入仍输出 `classification`。
- 协议版本、清单格式与渲染核心版本均未变化。

## 验证

- 全量测试 230 项通过（含新增 `test_rule_staleness.py` 10 项）。
- 本机安装后实测：运行记录出现 `summary.rule_warnings` 字段，正常规则下为 0。
