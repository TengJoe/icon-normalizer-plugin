# Icon Normalizer v1.1.17

发布日期：2026-11-06。扩展 **1.1.17**、配套后台 **3.1.14**（本版仅文档变更），支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 文档

- `docs/MAINTENANCE.md` 新增「规则失效与源图变更的应急处理」章节：
  - **症状**：图标风格突变、维护页告警、`status.rules_health.warnings > 0`。
  - **诊断**：读取 `last-run.json` 的 `rule_warnings` 与错误码含义表。
  - **处理**：重设类别、依赖文件名自动接续、改用 `plate-rounded`、或 `keep_desktop_override` 自备图标。
  - **案例**：DeepSeek Harness 图标回归的完整复盘。

## 说明

本版本不含代码变更，仅补齐运维文档。
