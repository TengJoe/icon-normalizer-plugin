# Icon Normalizer CLI 协议 v1

后台与前端之间的唯一通信方式：**一次性子进程 + 单行 JSON**。
请求经 stdin 整体读入，响应为 stdout 上的单行 JSON；诊断只能走 stderr。
本文件与 [JSON Schema 契约](contracts/)共同定义协议。既有操作的必需字段、语义或错误码发生破坏性变更时，必须升级 `api_version`；新增操作与可选响应字段可以向后兼容追加。
后台 3.1 追加五个操作，旧九个操作及 17 个错误码保持兼容。

## 1. 进程模型与隔离

| 组件 | 进程与依赖 | 通信或约束 |
| --- | --- | --- |
| Shell 扩展 | GJS、St | `Gio.Subprocess` 派生后台 |
| 设置窗口 | 独立 GJS、GTK 4、Libadwaita | `Gio.Subprocess` 派生后台 |
| 后台 | CPython ≥3.10、GTK 3、GdkPixbuf、Pillow、NumPy | 不加载 GTK 4 |

前端与后台只通过本协议通信；后台进程内出现 GTK 4 即为违例（`resolver.require_gtk3_only()` 卫哨拒绝）。

启动方式：

- 交互请求：`/usr/bin/python3 <libexec>/control.py --json`（等价 `python3 -m icon_normalizer --json`）
- systemd worker：`control.py --scheduled`（无 stdin，直接执行一次 apply）

## 2. 请求

```json
{"api_version":1,"request_id":"ui-1","operation":"scan","arguments":{}}
```

- 上限 64 KiB；UTF-8；严格 JSON（NaN/Infinity 常量拒绝）。
- `request_id`：1..96 字符 `[A-Za-z0-9_.:\-]`；响应原样回带，前端用于身份校验。
- 未知字段一律拒绝（`INVALID_REQUEST`）；布尔不接受为数字。

## 3. 操作与参数

| operation | arguments | 类别 | 锁等待预算 |
| --- | --- | --- | --- |
| `status` | `{}` | 读（免锁） | — |
| `doctor` | `{}` | 读（免锁） | — |
| `scan` | `{}` | 读 | 100 ms |
| `preview` | `{icon_id, source_sha256, size, draft?}` | 读 | 100 ms |
| `configure` | `{expected_revision, patch}` | 写 | 0 ms |
| `rules.set` | `{expected_revision, icon_id, rule}` | 写 | 0 ms |
| `apply` | `{expected_revision, activate}` | 写 | 0 ms |
| `automation.set` | `{enabled}` | 写 | 0 ms |
| `revert` | `{}` | 写（显式破坏性） | 0 ms |
| `profiles.list` | `{}` | 读 | 100 ms |
| `profiles.save` | `{expected_profiles_revision, name, parameters, profile_id?}` | 元数据写 | 0 ms |
| `profiles.delete` | `{expected_profiles_revision, profile_id}` | 元数据写 | 0 ms |
| `theme.follow` | `{enabled}` | 元数据写 | 0 ms |
| `theme.sync` | `{}` | 按当前系统主题维护 | 0 ms |

- `patch ⊆ {target, deadband, inner}`，≥1 项，范围 0.50–0.98 / 0.0–0.10 / 0.40–0.95，
  交叉约束 `0 < target-deadband ∧ target+deadband ≤ 1`。
- `rule`：`{reset:true}` 或 `{skip, classification∈(auto|plate-rect|plate-circle|artwork|glyph), source_sha256?}`；
  `auto` 禁带 `source_sha256`，手工分类必带（64-hex，绑定素材 SHA）。
- `size ∈ [16,24,32,48,64,96,128,256,512]`。

## 4. 并发控制（OCC）

1. **先上锁后读**：所有持锁操作按 `sync.lock(flock EX)` → 读 config/rules → 计算 `revision` →
   构建引擎 的顺序执行；初始化全程被错误信封覆盖。
2. `revision` = 规范化 JSON（target/deadband/inner/sizes/base_theme + user_rules）的 SHA-256。
3. 写操作携带 `expected_revision`；不匹配 → `REVISION_CONFLICT`（retryable，`details.current_revision`），
   拒绝覆盖。此处指 `configure`、`rules.set` 和 `apply` 的策略写入；`profiles.save`/`profiles.delete` 使用独立的 `expected_profiles_revision`。`automation.set`、`theme.follow`、`theme.sync` 与显式 `revert` 不要求策略 revision。
4. 读预算内未获锁 → `BUSY`（retryable，exit 3）；UI 写操作预算 0（即立即失败，不阻塞界面）。
5. worker（`--scheduled`）预算 750 ms，失败静默退出（exit 3），由下一轮 timer/path 重试。

## 5. 事务与自愈

- 文件事务：`pending.json`（0600）在首个变更文件前落盘，记录每文件
  `{path, before(b64), before_sha, after_sha, before_mode}`；manifest 最后提交；
  完成后移除日志；中途失败 → `recover()` 逆序回放（校验现盘 SHA ∈ {before, after}，外部改动则拒绝）。
- 主题激活：`settings-pending.json`（stage=files_committed）先于 `gsettings set` 落盘，
  回读确认后移除；后续核心写操作入口补齐未完成的激活。
- `scan` 拒绝在存在未恢复日志时运行（`RECOVERY_REQUIRED`）；核心写操作入口自动恢复；方案与跟随偏好的元数据操作不回放图标事务。

## 6. 响应信封

成功响应示例（方案目录为空；revision 仅作格式示意）：

```json
{"api_version":1,"request_id":"ui-1","operation":"profiles.list","ok":true,"result":{"profiles_revision":"0000000000000000000000000000000000000000000000000000000000000000","profiles":[]},"warnings":[]}
```

冲突响应示例（实际 revision 由后台计算）：

```json
{"api_version":1,"request_id":"ui-2","operation":"apply","ok":false,"error":{"code":"REVISION_CONFLICT","message":"Configuration changed","retryable":true,"details":{"current_revision":"0000000000000000000000000000000000000000000000000000000000000000"}}}
```

- stdout 上限 8 MiB，超限替换为 `IO_ERROR` 错误信封；stdout 永远只有一行 JSON。

## 7. 错误码与退出码

| code | retryable | exit |
| --- | --- | --- |
| BUSY / REVISION_CONFLICT / STALE_SOURCE / TIMEOUT | ✔ | 3 / 3 / 5 / 1 |
| INVALID_REQUEST / UNSUPPORTED_VERSION / INVALID_CONFIG | ✘ | 2 |
| NOT_INSTALLED / DEPENDENCY_MISSING / UNSUPPORTED_ENVIRONMENT | ✘ | 4 |
| RECOVERY_REQUIRED / OWNERSHIP_CONFLICT / AUTOMATION_FAILED | ✘ | 5 |
| NOT_FOUND / SOURCE_UNAVAILABLE / IO_ERROR / INTERNAL_ERROR | ✘ | 1 |

未知错误码默认按 retryable 处理（向前兼容）。退出码：0 成功，1 其他，2 输入错误，
3 忙，4 未安装/缺依赖，5 冲突类。

## 8. 前端等待纪律

- 读操作超时即击杀子进程；**写操作超时永不击杀**（结果未确认，UI 提示"结果尚未确认"）。
- 等待超时由 `extension/lib/backendClient.js` 定义，见下表。超时与锁等待预算是不同概念。
- 关闭请求作用域时取消读取；写操作继续执行并回收子进程，界面停止接收其结果。

| 操作 | 前端等待超时 |
| --- | --- |
| `status`、`doctor`、`profiles.list` | 5 s |
| `preview` | 15 s |
| `scan` | 120 s |
| `configure`、`rules.set`、`apply`、`theme.sync` | 125 s |
| `revert` | 130 s |
| `automation.set` | 30 s |
| `profiles.save`、`profiles.delete`、`theme.follow` | 10 s |

- 响应 `request_id`/`operation`/`api_version` 不匹配按 `INTERNAL_ERROR` 处理。

## 9. 后台 3.1 追加操作

- 自定义方案仅存 target/deadband/inner；参数范围和交叉约束与 configure 一致。
  方案 id 为 32 位小写 hex，名称 NFC 规范化、去除首尾空白、1–64 个可显示字符，
  拒绝控制字符；casefold 同名拒绝，最多 50 项。创建/重命名/删除均不改变生效策略。
- 三个 profiles 操作返回 `{profiles_revision, profiles:[{id,name,parameters}]}`。
  profiles_revision 为独立目录的规范化 SHA-256；save/delete 不匹配返回既有
  REVISION_CONFLICT（details.current_profiles_revision）。profile_id 缺省创建，指定更新。
- profiles.json、theme-follow.json 为 schema_version=1 的用户私有 0600 文件。
  theme-follow.json 缺省跟随开启，读取默认值不创建文件。theme.follow 返回 `{enabled}`；
  status 追加可选 `theme_follow:boolean|null`，null 表示无法确认。
- theme.sync 返回 `{changed,revision,source_theme,...apply_result}`。跟随与自动维护开启时，
  新选择的已安装图标主题成为素材主题；视觉参数与逐图标规则保留。
  config/baseline/图标/manifest 同一前置日志事务提交；失败一并回滚。
  新的素材主题成为还原目标，激活日志记录 only_if_current_theme，尊重渲染期间
  用户后续选择。重新选择原素材主题不会强制激活；显式 Apply & activate 可以恢复。
- 后台 scheduled 模式也执行主题跟随，前端关闭时由 timer 兜底；Shell 监听只作加速。
  关闭自动维护时 theme.sync 不迁移，显式 apply 仍可以执行用户请求。
- metadata 操作不会回放尚未恢复的图标事务；核心写操作先恢复并重新读取 policy/revision。
