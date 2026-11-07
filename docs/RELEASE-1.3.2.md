# Icon Normalizer v1.3.2

发布日期：2026-11-07。扩展 **1.3.2**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。

## 修复：控制层协议接缝补齐

1.3.0 把引擎搬进扩展进程后，有四个协议操作只保留了"形状"而没有真正落盘。它们都返回 `ok: true`，所以界面显示成功，改动却被丢弃。本版本逐个补齐：

| 操作 | 1.3.1 及之前 | 现在 |
| --- | --- | --- |
| `configure` | 读取 `args.policy`，而界面发的是 `args.patch` —— **规则页"保存"静默无效** | 合并 `patch`、校验取值范围与交叉约束、返回 `changed` |
| `profiles.list/save/delete` | 空壳，返回 `{profiles: []}` / `{ok: true}` —— **命名方案保存后丢失** | 真实写入 `profiles.json`，含重名、上限 50、`REVISION_CONFLICT` 校验 |
| `theme.follow` | 只回显参数 | 写入 `theme-follow.json`，`status.theme_follow` 如实反映 |
| `automation.set` | 只回显参数 | 写入 `automation.json`，并由扩展自身定时执行 |

## 新增：扩展自带的周期维护

纯 GJS 架构没有 systemd 单元，因此自动维护改由扩展自己调度：

- 启用后约 90 秒执行首次维护，此后每 15 分钟一次，使用切片引擎，不阻塞桌面；
- 每轮写入 `maintenance-heartbeat.json`；「维护」页据此区分 **on**（最近跑过）/ **unknown**（已开启但还没跑过）/ **off**；
- 最近一次失败会以 `automatic_error` 出现在状态里，不再只是界面上一个沉默的徽标。

## 测试

- Q18 新增 4 组用例，直接使用**界面真实发送的载荷形状**（`patch`、`profiles.*` 的 revision 对象、`theme.follow`、`automation.set`），防止同类接缝再次"通过测试但不工作"。
- 原有 `configure` 用例改用协议形状；此前它按实现写成了 `policy`，因而掩盖了这个缺陷。
- 响应式冒烟用例在 `retryable` 错误上重试，并在失败时打印完整错误信封（此前只打印一句 "External fixture update failed"）。

## 验证

- 19 道质量门全部通过（`bash tools/verify.sh`）。
