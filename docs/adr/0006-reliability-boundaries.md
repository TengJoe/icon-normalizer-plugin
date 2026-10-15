# ADR-0006：轻量诊断、所有权冲突和维护健康状态

状态：已实现，扩展 1.1.3 / 后端 3.1.2。发布与验收边界见 [1.1.3 发布说明](../RELEASE-1.1.3.md)。

## 决策

继续使用 Python 后端和 GJS 前端。渲染、分类、事务格式、CORE_VERSION=2、源主题与视觉参数保持不变，不新增常驻进程或自动强制修复。

- `fingerprints.py` 只用标准库读取 analyzer/renderer 源码，按原公式计算指纹，不导入图像模块。
- `dependencies.py` 为 status 提供轻量模块存在性探测，为图像操作提供显式运行依赖检查。存在性探测不等价于完整 ABI/typelib 健康证明；doctor 执行更完整检查。
- `ownership.py` 产生 OWNERSHIP_CONFLICT（exit 5），提供路径、图标名、原登记/当前 SHA-256 和类型。按路径去重排序，最多返回 100 条，并提供总数与 truncated 标记。
- `health.py` 管理活动故障、解除条件与有界历史。control 仍拥有 sync.lock 和业务操作顺序。

## 依赖故障

status 和 doctor 不再因启动时导入 PIL/numpy 而失效。图像操作缺少已知 Python 模块或指定 Gtk/GdkPixbuf typelib 时返回 DEPENDENCY_MISSING/4。未知模块错误、其他编程错误不伪装成缺依赖。

doctor 仍正常返回检查响应，通过 result.ok_all=false、checks、missing 表达检查失败，不把诊断命令本身变成失败信封。

## 错误记录和解除

last-error.json 顶层保留 code/message/at_unix，兼容旧读取者；active 下分别保存 maintenance、automation。维护故障优先显示，修复开关不能遮蔽尚未解决的维护故障。

活动故障增加 operation、details、first_seen_unix、last_seen_unix、count、signature。相同 code/message/details 更新最近时间和次数，保留首次时间；原因变化建立新记录。

health-events.json 最多保存 64 条紧凑事件，只记首次失败、原因变化和恢复，不复制长冲突清单。首次/变化/恢复写简短 journal 信息；重复故障每 10 次输出计数。状态和 health.lock 均为 0600。

业务失败在释放 sync.lock 前登记，避免上一轮失败在新一轮成功之后补写旧错误。health.lock 只保护健康记录，等待最多 100ms；从不持有它再请求 sync.lock。健康记录写入失败会输出 stderr。

完整 apply、实际执行维护的 theme.sync、完整 scheduled 循环或 revert 成功后才解除维护故障。automation.set 成功只解除 automation 故障。状态读取、扫描成功、保存配置、版本冲突、空操作 theme.sync 和单独事务恢复均不能解除维护故障。正常 BUSY/REVISION_CONFLICT/STALE_SOURCE 等不进入持久化健康状态。

## 状态与时间

API v1 的操作和错误码不变，只增加可选状态信息：last_check_at 为最近完整维护成功的时间；last_apply_at 从 last-run.json 的 last_updated_at_unix 读取，只有输出实际变化时推进。last_error 可附详情、首次/最近时间和次数。

旧 last-run 的 file_operations 包括元数据写入，无法证明实际输出更新时间。因此缺少 last_updated_at_unix 的历史记录显示“暂无更新记录”，不使用检查时间猜测；下一次实际更新后记录准确时间。

界面分别显示触发器、维护结果和主题状态。维护故障显示“维护受阻”，即使上次主题仍生效；开关请求失败单独显示“自动维护设置失败”。中英文详情显示只读冲突收据与首次/最近时间，不执行修复、不采纳哈希、不覆盖文件。

## 验证和回退

自动化覆盖依赖缺失、未知导入异常、多冲突与拒绝写入、还原冲突、计数并发、首次时间、分类解除、旧记录、有界历史、零改动时间、中英文顶栏和真实 GTK 详情/恢复。

测试使用私有 HOME/状态/主题、memory GSettings 和独立 manager；不向真实 Shell 注入故障。旧客户端可以忽略新增字段，manifest 与事务格式保持不变。回退使用上个完整发行包与安装快照，保留 baseline/manifest/规则；不通过删除主题或重建基线处理冲突。
