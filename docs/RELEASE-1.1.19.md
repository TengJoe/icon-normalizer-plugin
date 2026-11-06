# Icon Normalizer v1.1.19

发布日期：2026-11-06。扩展 **1.1.19**、配套后台 **3.1.16**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 新增

- `doctor` 增加规则审核：

```json
{ "checks": { "rules": { "ok": true, "user_rules": 1, "reviewed_overrides": 0,
                       "warnings": 0, "errors": [] } } }
```

- `warnings` 与 `errors` 直接对应上次运行的 `rule_warnings`，便于排查"图标为什么没按规则渲染"。
- 该检查恒为 `ok: true`，仅提供信息，不影响 `doctor` 的整体结论。

## 验证

- 后端全量 **250 项测试通过**。
