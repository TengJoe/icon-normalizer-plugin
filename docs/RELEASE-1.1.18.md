# Icon Normalizer v1.1.18

发布日期：2026-11-06。扩展 **1.1.18**、配套后台 **3.1.15**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 新增

- **失效规则详情弹窗**：维护页告警旁的「查看详情」打开列表，逐条显示应用名、错误码（`RULE_STALE_SOURCE` / `OVERRIDE_STALE_SOURCE` / `RULE_INVALID` …）与当前指纹，并为每条提供「重置为自动」按钮。
- **`status.rule_warnings`**：返回上次运行的告警明细（含 `rule_key`），界面无需再读 `last-run.json`。

## 兼容性

- `rule_warnings` 为可选字段，已登记到 `contracts/status-result.schema.json`；旧客户端缺失时为 `[]`。

## 验证

- 后端 **249 项测试通过**；前端逻辑 **13/13 ×2 + 11/11 + 16/16 + 5/5** 全绿；`npm run lint` 无告警。
- 本机实测：`status.rule_warnings` 返回 `[]`（当前无失效规则），`rule_health.warnings = 0`。
