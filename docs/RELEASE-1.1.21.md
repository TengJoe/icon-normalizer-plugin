# Icon Normalizer v1.1.21

发布日期：2026-11-06。扩展 **1.1.21**、配套后台 **3.1.17**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 修复

- **重置对覆盖类告警无效**：1.1.18 引入的「重置为自动」只调用 `rules.set {reset:true}`，删除的是用户规则；而 `OVERRIDE_STALE_SOURCE` 的条目在 `overrides.json` 里，因此按钮按下去告警仍在。
- 现在重置会同时清理本机 `overrides.json` 中匹配该图标的条目（路径或其 SHA 均可），两类告警都能真正清除。

## 兼容性

- 仅涉及本机文件 `<state>/overrides.json`；随包发布的 portable 覆盖不受影响（它们属于发行内容）。

## 验证

- 后端全量 **251 项测试通过**（`test_stale_override.py` 3 项）。
