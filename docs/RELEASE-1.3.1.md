# Icon Normalizer v1.3.1

发布日期：2026-11-07。扩展 **1.3.1**、配套后台 **3.1.20**（未变更），支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

本版是 1.3.0 发布当日的加固批次：对纯 GJS 内嵌引擎做了一次独立代码与架构审查，修复了全部红线与主要发现。没有新增用户功能；1.3.0 的架构与能力完整保留。

## 修复内容

### 并发安全（审查定级 P0）

- **跨进程单写者锁**：新增 `SyncLock`，以 flock 持有进程方式锁定 `~/.local/state/icon-normalizer/sync.lock`——与可选 Python 后台 worker 共用同一把锁。Shell 进程、设置窗口与后台 worker 至多一个写者；争用时返回可重试的 `BUSY`。进程崩溃由内核自动释放锁，无残留锁风险。
- **崩溃回滚不再误伤**：`recover()` 落实协议 §5 的 `∈{before, after}` 校验。中断事务的回滚只作用于该事务自己的产物；用户或他进程在崩溃后写入的文件严格拒绝触碰，用户新建的文件不再被误删。
- **策略并发保护**：写操作落实 `expected_revision`，不匹配返回 `REVISION_CONFLICT`（含 `current_revision`），两个窗口并发保存不再互相整体覆盖。

### 主线程防冻结（审查定级 P1）

- 引擎的分析/渲染阶段重构为生成器，宿主以 `GLib.idle_add` 时间片驱动（默认 20ms 切片）。Shell 顶栏与设置窗口均已启用——批量渲染 70+ 应用图标时桌面保持可交互；首次运行、策略变更、批量新装应用不再造成分钟级冻结。

### 协议接缝（审查定级 P1）

- **预览修复**：纯 GJS 后端的 `preview` 返回与协议一致的形状（`original_png_base64` / `proposed_png_base64` / `metrics` / `action` / `classification`），设置窗口的效果预览在仅装扩展时恢复正常，并新增 `STALE_SOURCE` 校验。
- **主题激活**：面板「立即应用」现在会按请求把 icon-theme 切到 DockNormalized，并如实报告 `applied / unavailable / superseded`。
- **恢复链路**：存在未恢复事务日志时 `scan` 返回 `RECOVERY_REQUIRED`，面板的自动恢复分支恢复工作。

### 其他修复与加固

- **应用收集修复**：未设置 `ICON_NORMALIZER_APPLICATION_DIRS` 时扫描不到任何应用的缺陷（空列表遮蔽 XDG 根目录）——修复后实测恢复 85 组图标。
- **stale 清理保护**：主题目录内用户手工放入的文件不再被静默删除，改为报告 `UNTRACKED_THEME_FILE`；清理仅限引擎自有命名。
- **单文件故障隔离**：单个无法解析的 `.desktop` 降级为警告，不再使整轮维护失败。
- **生命周期**：进程内后端随 `disable()` 清理，不在 enable 周期之外残留。
- **加固**：源图解码 4096px 上限防御；路径 `..` 词法规范化；`.desktop` 重写按字节保真（fatal 解码、保留 BOM 与行尾）；高斯模糊边界对齐 PIL；本地后端错误码透传。
- **测试**：GJS 测试 harness 修复了 async 测试不被等待、失败被计为通过的问题；单测从 61 项增至 **69 项**（新增回滚安全、跨进程锁、idle 分片用例）。

## 验收

- **19 道质量门全量通过**（`bash tools/verify.sh`），含 144 组渲染 + 69 组分析 parity。
- 真机行为验证：带锁 live scan、外部持锁 BUSY 互斥、构建逐字节可复现（两次构建与发布资产 SHA-256 一致）。
- `npx eslint extension --max-warnings 0` 零告警。
