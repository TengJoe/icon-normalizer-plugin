# ADR 0002 — 协议 v1 冻结与 OCC / 事务语义加固

状态：已采纳　日期：2026-10-02

## 背景

v1 线协议（9 操作、17 错误码、信封、退出码）已被前端与契约测试依赖，语义健康；
但实现存在若干偏差：状态文件 0644 落盘、preview 超限误报 `INTERNAL_ERROR`、
`settings-pending.json` 有恢复逻辑却无写入方（死路径）、`MAX_STDIN` 海象表达式遮蔽模块常量。

## 决策

1. **线格式逐字节冻结**：`contracts/*.schema.json` 为唯一契约；请求解析继续拒绝
   未知字段 / 布尔伪装数字 / NaN+Infinity；错误码与退出码映射不变。
2. 锁序铁律落地为 `control.handle()` 单一路径：`_acquire(budget)` → `ConfigStore` →
   `revision` → 引擎构建 → 操作。读操作预算 100ms（scan/preview），UI 写 0ms，调度 worker 750ms；
   超时返回可重试 `BUSY`（exit 3）。
3. `revision` = 规范化 JSON（target/deadband/inner/sizes/base_theme + user_rules）的 SHA-256，
   写操作必须携带 `expected_revision`，冲突拒绝覆盖并回传 `current_revision`。
4. 主题激活二阶段事务转正：`apply(activate=true)` 先写 `settings-pending.json`
   (stage=files_committed, activate_theme)，再 `gsettings set` + 回读确认，确认后移除日志；
   任何写操作入口的 `_recover_transactions` 据此补齐激活 —— 控制流自 v2 的死代码变为真实自愈路径。
5. 全部状态 JSON（config/rules/last-run/last-scan/last-error/pending）经统一原子写器以 0600 落盘。
6. 错误码纠偏：preview PNG 超 2MiB 信封上限 → `IO_ERROR`（不再 `INTERNAL_ERROR`）。

## 后果

- 前端零改动即可对接（超时表/信封语义不变）。
- 新增 `settings-pending.json` 为合法状态文件；`status.recovery_pending` 语义已覆盖之。
