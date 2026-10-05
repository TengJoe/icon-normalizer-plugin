# Icon Normalizer 架构说明

本文说明扩展 **1.1.1**、后台 **3.1.0** 的工程结构。架构沿用 3.0 重构的进程隔离与事务设计，并加入自定义方案、主题跟随和中英文支持入口。

[使用说明](README.md) · [协议规范](PROTOCOL.md) · [架构决策记录](docs/README.md#架构决策记录--architecture-decision-records)

## 1. 系统总览

Shell 扩展、设置窗口和 Python 后台分别运行。Shell 使用 GJS 与 St，设置窗口使用 GJS、GTK 4 与 Libadwaita，后台使用 Python、GTK 3 与 GdkPixbuf。

```text
GNOME Shell                         设置窗口（独立 GJS 进程）
extension.js → indicator.js          prefs.js → preferences.js
GJS / St                            GTK 4 / Libadwaita
         │                                      │
         └────── lib/backendClient.js ──────────┘
                            │ Gio.Subprocess：固定 argv + JSON stdin
                            ▼
Python 后台：control.py --json       systemd：control.py --scheduled
                            │                    │
                            └────── control.handle() / worker ──────┐
                                                                   │
         协议校验 → sync.lock → 配置与 revision → 引擎/方案/主题操作 ◄┘
                            │
                            ▼
               TransactionStore：前置日志、原子写、恢复
                            │
                            ▼
  用户图标主题 / 用户启动器覆盖 / 私有状态 / 预览缓存
```

交互请求通过一次性子进程和单行 JSON 通信。自动维护由用户级 systemd 单元触发，不依赖设置窗口或顶栏按钮。

## 2. 工程布局

下表列出主要模块；协议字段与等待预算以 [PROTOCOL.md](PROTOCOL.md) 为准。

| 目录或文件 | 职责 |
| --- | --- |
| `backend/control.py` | 已安装后台入口，转发至 `icon_normalizer.control` |
| `backend/icon_normalizer/control.py` | 14 项操作的路由、锁序、恢复与调度 |
| `backend/icon_normalizer/protocol.py` | 请求解析、参数校验、响应信封 |
| `backend/icon_normalizer/version.py` | 后台、协议与渲染版本常量 |
| `backend/icon_normalizer/policy.py`、`config_store.py` | 策略校验、规范化 revision、配置与规则持久化 |
| `backend/icon_normalizer/profiles.py` | 命名方案目录、独立 revision 与名称校验 |
| `backend/icon_normalizer/theme_follow.py` | 跟随偏好、素材主题迁移与还原目标 |
| `backend/icon_normalizer/desktop.py`、`theme.py` | 启动器扫描与 `Icon=` 改写、主题索引与图标缓存 |
| `backend/icon_normalizer/preview.py` | 独立预览渲染与缓存 |
| `backend/icon_normalizer/service_control.py` | systemd 用户单元的查询、启停与失败恢复 |
| `backend/icon_normalizer/core/` | 分析、渲染、图标解析、归一化编排与文件事务 |
| `extension/extension.js`、`prefs.js` | Shell 扩展与设置窗口入口 |
| `extension/lib/` | 后台客户端、状态映射、应用编排、界面原语、翻译与项目信息 |
| `extension/ui/` | 三页设置、命名方案、图标预览、顶栏菜单与支持弹窗 |
| `extension/assets/` | 单色 SVG 与维护者授权的微信、支付宝收款码 |
| `extension/schemas/` | GSettings schema |
| `contracts/` | 协议 v1 JSON Schema 与示例 |
| `packaging/systemd/` | `service`、`timer`、`path` 模板 |
| `tools/` | 安装布局、构建、安装、卸载与发布审计 |
| `tests/` | 后台、安装故障、前端逻辑与隔离运行时验收 |
| `docs/` | 发布验收、提交说明、支持入口与 ADR |
| `.github/FUNDING.yml` | GitHub 支持按钮指向公开支持页面 |

## 3. 模块边界

| 模块 | 负责 | 边界 |
| --- | --- | --- |
| `protocol.py` | 线格式、参数校验、信封与错误码 | 不执行图像处理或文件事务 |
| `control.py` | 先锁后读、revision 校验、操作分发与恢复 | 算法由核心模块实现 |
| `policy.py` | 策略模型、范围与交叉校验、revision | 不写文件 |
| `config_store.py` | 配置与用户规则持久化 | 调用方持有 `sync.lock` |
| `profiles.py` | 方案存储、名称与数量限制、目录 revision | 保存或重命名方案不改变生效策略 |
| `theme_follow.py` | 跟随偏好、迁移策略与 baseline | 图标迁移通过引擎和事务提交 |
| `core/engine.py` | 扫描、分析、渲染、增量复用与还原编排 | 不定义协议线格式 |
| `core/analyzer.py` | 几何分析、分类与死区决策 | 不访问文件或渲染 |
| `core/renderer.py` | 底板、阴影与测量校正 | 不访问文件或决定分类 |
| `core/resolver.py` | GTK 3 图标解析与素材装载 | 拒绝在后台进程加载 GTK 4 |
| `core/transaction.py` | 路径检查、原子写、日志与恢复 | 不决定业务上需要写什么 |
| `preview.py` | 预览与独立缓存 | 不修改生效配置和托管图标 |
| `extension/lib/`、`extension/ui/` | 展示、用户交互与请求编排 | 不计算图标策略或直接写后台状态 |

## 4. 设计约束

### 用户级安装与系统只读

原始图标和系统启动器只读。主要写入位置为：

- `~/.local/share/icons/DockNormalized/`：生成图标、主题索引与缓存。
- `~/.local/share/applications/`：必要的用户级启动器覆盖。
- `~/.local/state/icon-normalizer/`：配置、规则、方案、日志与恢复记录。
- `~/.cache/icon-normalizer/`：预览与缓存。

安装代码、扩展与服务单元由 `tools/layout.py` 定义用户级布局。文件事务拒绝白名单之外的路径与不受信任的符号链接；systemd 单元通过 `ProtectSystem=strict`、`ProtectHome=read-only` 和限定的 `ReadWritePaths` 约束后台写入。

### GTK 进程隔离

后台的 `require_gtk3_only()` 检查 GTK 版本。Shell 与设置窗口仅通过 JSON CLI 请求后台，不在同一进程混用 GTK 3 和 GTK 4。

### 先锁后读与并发控制

持锁操作遵循 `sync.lock → ConfigStore → revision → 引擎/操作` 的顺序。策略写入校验 `expected_revision`，方案写入校验独立的 `expected_profiles_revision`。冲突返回 `REVISION_CONFLICT`，不覆盖较新的配置。

状态读取与诊断免锁；其他读操作等待最多 100 ms，交互写操作不等待，调度 worker 等待最多 750 ms。具体例外与元数据操作见协议表。

### 日志前置与事务恢复

`pending.json` 以 0600 权限在首个文件变更之前落盘。恢复时校验现有内容是否仍为事务记录的前后版本，再逆序回放；外部修改会阻止自动覆盖。主题激活另有 `settings-pending.json`，写入后设置并读回确认，成功才删除日志。

### 生命周期与支持入口

关闭设置或停用顶栏只结束对应界面与监听。后台自动维护由 `timer` 和 `path` 管理；还原通过显式操作执行。

支持入口只显示维护者授权的原始收款码，或打开项目与反馈链接。付款在微信或支付宝中完成，扩展不读取、追踪或验证交易。

## 5. 关键数据流

### 扫描与预览

1. 前端发送 `scan`，后台获取锁后读取策略与规则。
2. 主线程完成启动器扫描和所有 `Gtk.IconTheme` 查询。
3. 工作线程执行 GdkPixbuf 装载及 Pillow、NumPy 分析；结果按键排序。
4. 主线程生成死区决策与分组，更新扫描记录并返回响应。
5. `preview` 使用独立缓存显示对比，不改变生效配置或托管图标。

### 应用与增量复用

`apply` 校验 revision 并恢复未完成事务，再生成变更计划。未变化的输入与策略复用已有 PNG，未变化的文件不进入事务；暂时缺失的源素材可以保留上一代产物并报告警告。

文件事务提交后，按请求决定是否激活 `DockNormalized`。激活需要日志前置与读回确认，结果写入运行记录。

标准参数为 88% 目标占比、±2 个百分点容差和 72% Logo 内层占比。输出尺寸固定为 `16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 px`。

### 自定义方案与主题迁移

命名方案仅保存三项视觉参数，最多 50 项。使用方案填入前端草稿，显式保存后才改变生效策略。

跟随与自动维护开启时，新选择的已安装图标主题成为素材主题。图标、配置、baseline 与 manifest 在同一文件事务内迁移，保留视觉参数与逐图标规则。激活守卫检查当前主题，避免迟到的迁移覆盖用户的新选择。

### 自动维护与恢复

`path` 监听用户、系统与系统级 Flatpak 启动器目录；`timer` 每分钟提供兜底检查。后台通过安装时配置的用户级单元运行，不依赖图形界面打开。

还原恢复托管启动器与最近选择的素材主题。未被外部编辑的托管字节可原样恢复；冲突保留外部编辑并报告失败。卸载先请求后台还原，再移除代码与单元，保留备份。

## 6. 兼容与发布

协议保留 `api_version=1`，原九项操作与 17 个错误码保持兼容；后台 3.1 增加五项操作和可选字段。既有必需字段或语义的破坏性变更需要升级协议版本。

manifest 与核心恢复记录延续兼容格式，方案与主题跟随使用新增的私有状态文件。`policy_sha256` 随算法源字节演进；算法基准变化后的首次应用可能重新渲染图标。

扩展版本由 `extension/metadata.json` 提供，后台版本由 `backend/icon_normalizer/version.py` 提供。本版兼容声明为 GNOME Shell 51；ADR 中的 45–51 范围记录早期设计，不代表当前验收结论。

构建、安装、失败恢复与提交检查分别见[贡献指南](CONTRIBUTING.md)、[验收清单](docs/CHECKLIST.md)和[GNOME Extensions 提交说明](docs/SUBMISSION.md)。历史修复见 [CHANGELOG.md](CHANGELOG.md)。
