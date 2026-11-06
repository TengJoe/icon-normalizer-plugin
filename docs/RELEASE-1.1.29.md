# Icon Normalizer v1.1.29

发布日期：2026-11-06。扩展 **1.1.29**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 改进

- **健康事件闭环**：规则失效时记 `degraded`，恢复后补记 `recovered`（同一 `code = RULE_STALE`）。维护页的「故障详情」因此能看出问题是否已解决。

## 验证

- 后端全量 **253 项测试通过**（`test_stale_override.py` 覆盖 degraded → recovered 全流程）。
