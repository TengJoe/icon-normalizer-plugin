# Icon Normalizer v1.1.15

发布日期：2026-11-06。扩展 **1.1.15**、配套后台 **3.1.13**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 变更

- 规则镜像写法冲突（`class` 与 `classification` 并存且不同）判为 `invalid`，运行记录会以 `RULE_INVALID` 告警，避免"看起来设置了却没生效"。
- 新增 ADR-0005，把规则模型的边界写成文档：两套机制、匹配顺序、skip 语义、失效报告。

## 验证

- 全量后端测试 **247 项通过**（`test_rule_staleness.py` 增至 11 项）。
