# Icon Normalizer — Architecture Specification (v3.0)

> 面向 Linux / GNOME 桌面的应用图标归一化插件与后台维护服务。
> 本文档是 3.0 全局重构后的工程基准；历史演进记录见 `docs/adr/`，协议线格式见 `PROTOCOL.md`。

## 1. 系统总览

```
┌────────────────────────────── GNOME Shell (GJS, Gtk4/Adwaita) ──────────────────────────────┐
│  extension.js (面板指示器，可选)          prefs.js → preferences.js (规则/应用/维护 三页)      │
│        └────────────── lib/backendClient.js ── Gio.Subprocess ──┐                            │
└─────────────────────────────────────────────────────────────────┼────────────────────────────┘
                                                                  │ 单行 JSON 请求/响应 (stdin/stdout)
┌───────────────────────── 后端进程 (Python 3.10+, Gtk3/GdkPixbuf) ─┴──────────────────────────┐
│  control.py (--json / --scheduled)   ← sync.lock 先锁后读 → ConfigStore → revision(OCC)       │
│      ├── protocol.py        v1 线协议：严格解析 / 校验 / 信封 / 退出码                          │
│      ├── policy.py          策略模型、校验、revision 计算                                      │
│      ├── preview.py         高清对比预览（独立 LRU 缓存，绝不触碰生产状态）                     │
│      ├── service_control.py systemd 用户单元适配器（timer/path）                               │
│      └── core/              归一化引擎                                                        │
│           ├── engine.py       并发扫描 + 增量对比 + 计划/应用/回滚编排                          │
│           ├── analyzer.py     Alpha 多阈值几何分类器（底板/圆形/裸Logo/插画）                   │
│           ├── renderer.py     超椭圆磨砂底板、对比色自适应、阴影衰减                            │
│           ├── transaction.py  原子写入 + pending.json 前置日志 + 崩溃自愈                       │
│           └── resolver.py     Gtk3 图标解析（强制 Gtk3-only 卫哨）                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ 事务提交                                                    ▲ 每 1 分钟 / 入口目录变化
        ▼                                                             │
  ~/.local/share/icons/DockNormalized (Inherits=<原生主题>,hicolor)    systemd --user
  ~/.local/share/applications/ (仅绝对路径图标的字节级可还原覆盖层)      icon-normalizer.{service,timer,path}
```

## 2. 工程目录树

```
icon-normalizer-plugin/
├── ARCHITECTURE.md            # 本文档
├── PROTOCOL.md                # 协议 v1 冻结规范（等待预算、错误码、锁序、信封）
├── README.md
├── CHANGELOG.md
├── pyproject.toml             # mypy 严格模式等工具配置（非发布包）
├── contracts/                 # 协议 JSON Schema（冻结，前端/后端共同契约）
│   ├── request.schema.json
│   ├── response.schema.json
│   ├── policy.schema.json
│   ├── status-result.schema.json
│   ├── requests.example.json
│   └── responses.example.json
├── backend/
│   ├── control.py             # 已安装入口 shim：转发到 icon_normalizer.control
│   └── icon_normalizer/       # 现代化后端包（唯一实现）
│       ├── __init__.py
│       ├── __main__.py        # python3 -m icon_normalizer --json|--scheduled
│       ├── version.py         # 唯一版本源（BACKEND_VERSION / API_VERSION / CORE_VERSION）
│       ├── errors.py          # 错误码表 + ProtocolError + 退出码映射
│       ├── xdg.py             # 运行时路径推导（XDG + 环境覆盖；禁止导入期捕获）
│       ├── policy.py          # Policy 模型 / 校验 / revision（规范化 SHA-256）
│       ├── config_store.py    # config.json + user-rules.json 持久化（调用方持锁）
│       ├── protocol.py        # v1 请求解析、参数校验、响应信封
│       ├── control.py         # 命令分发路由器（9 操作）
│       ├── preview.py         # 预览渲染与缓存
│       ├── service_control.py # systemd 触发器查询/启停（带回滚）
│       ├── gsettings.py       # GSettings 读写隔离层（fixture 可注入 None）
│       ├── desktop.py         # .desktop 扫描、可见性判定、外科手术式 Icon= 改写
│       ├── theme.py           # 覆盖主题 index.theme、所有权标记、图标缓存重建
│       └── core/
│           ├── __init__.py
│           ├── engine.py      # 归一化编排引擎（并发扫描、增量对比、事务编排）
│           ├── analyzer.py    # 几何分类器（analyze/classify/plan，含死区）
│           ├── renderer.py    # 渲染管线（superellipse/对比底板/阴影/测量校正）
│           ├── transaction.py # 原子写入器 + 事务日志 + 自愈恢复
│           └── resolver.py    # Gtk3 图标解析与素材装载（Gtk3-only 卫哨）
├── extension/                 # GNOME Shell 扩展（GJS ESM，Gtk4/Libadwaita）
│   ├── extension.js           # Extension 子类（GNOME 45+ ESM）
│   ├── prefs.js               # ExtensionPreferences 子类 + fillPreferencesWindow
│   ├── metadata.json          # shell-version 45..51
│   ├── stylesheet.css
│   ├── schemas/org.gnome.shell.extensions.icon-normalizer.gschema.xml
│   ├── lib/
│   │   ├── backendClient.js   # Gio.Subprocess 异步客户端（写操作永不超时击杀）
│   │   ├── stateModel.js      # 状态→文案纯映射（无副作用）
│   │   ├── applyFlow.js       # status→apply→status 编排（扩展面板与维护页共用）
│   │   └── uiCommon.js        # 信号守卫、胶囊组、纹理缓存、对话框呈现兼容层
│   └── ui/
│       ├── preferences.js     # 三页组装与刷新调度
│       ├── appsPage.js        # 应用图标页：ListView 虚拟化 + 搜索 + 筛选胶囊
│       ├── previewDialog.js   # Adw.Dialog 实时对比（多尺寸/深浅底）
│       ├── rulesPage.js       # 规则页：Adw.SpinRow + 预设
│       ├── maintenancePage.js # 维护页：卡片式仪表盘 + 立即应用/完全还原
│       └── indicator.js       # 顶栏指示器（状态目录监听 + 防抖）
├── packaging/systemd/
│   ├── icon-normalizer.service
│   ├── icon-normalizer.timer
│   └── icon-normalizer.path
├── tools/
│   ├── layout.py              # 安装布局唯一事实源（install/uninstall 共用）
│   ├── install.py             # 快照→停触发→暂存验证→原子换装→恢复触发
│   ├── uninstall.py           # 100% 无残留卸载（含后端 revert）
│   └── build.py               # 扩展 ZIP + 完整发行包 + 严格 schema 编译
└── tests/
    ├── backend/               # unittest 沙箱化全套（协议/OCC/事务/生命周期/预览/E2E）
    ├── frontend/              # node --check 语法门 + 纯逻辑单测
    └── installation/          # 真实安装/卸载回归（临时 HOME）
```

## 3. 模块职责边界

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| `protocol.py` | 线格式解析、参数校验、信封构造、退出码 | 任何业务逻辑、磁盘写 |
| `control.py` | 锁序编排（先锁→后读→建引擎）、操作分发、错误记录 | 图像算法、GSettings 之外的写盘 |
| `policy.py` | 策略数据模型、范围/交叉校验、revision | 文件 IO |
| `config_store.py` | 策略/规则持久化与迁移（schema v1→v2） | 加锁（调用方持有 sync.lock） |
| `core/engine.py` | 扫描→分类→决策→渲染→事务编排；增量复用；回滚 | 协议格式、systemd |
| `core/analyzer.py` | 纯函数几何分析/分类/决策计划（含死区） | IO、渲染 |
| `core/renderer.py` | 纯函数渲染管线（输入 PIL 图像与指标） | 磁盘、分类 |
| `core/transaction.py` | symlink 拒写、原子写、日志前置、自愈恢复 | 决策"写什么" |
| `desktop.py` | 入口扫描、可见性、Icon= 外科手术改写 | 主题文件 |
| `preview.py` | 只读预览 + LRU 缓存（独立目录） | 生产状态任何写 |
| `extension/lib/*` | 子进程通信、状态文案、UI 编排复用 | 策略计算（后端是唯一写者） |

## 4. 设计铁律 → 落点映射

| 铁律 | 落点 |
|---|---|
| 零 root / 系统只读 | `xdg.py` 全路径位于 `$HOME`；`transaction.py` 白名单根（theme/state/user-applications）之外的写直接抛 `UnmanagedOutputPath`；systemd 单元 `ProtectSystem=strict + ReadWritePaths` 收口 |
| Gtk3/Gtk4 进程隔离 | 后端仅在 `core/resolver.py` 与 `gsettings.py` 触及 gi；`require_gtk3_only()` 卫哨拒绝混装；前端仅 `gi://Gtk`(4)/Adw；两界只经 JSON CLI |
| 先锁后读 / OCC | `control.handle()`：`_acquire(budget)` → `ConfigStore` → `revision` → 引擎；写操作携带 `expected_revision`，冲突返回 `REVISION_CONFLICT`；读操作预算 ≤100ms |
| 事务自愈 | `transaction.py`：`pending.json`（0600）先于首个变更落盘；`recover()` 校验现盘 SHA ∈ {before, after} 后逆序回放；manifest 最后提交 |
| 生命周期三开关 | 前端仅 UI（`disable()` 只拆除指示器）；自动化独立于 `timer/path` 单元；`revert` 是显式破坏性操作且不校验 revision |
| 无硬编码用户路径 | overrides.json 仅保留可移植条目；用户专属条目迁移到 `~/.local/state/icon-normalizer/overrides.json`（若存在则合并）；`gtk-update-icon-cache` 用 `shutil.which` 探测；默认主题回退 `hicolor` |

## 5. 关键数据流

### 5.1 扫描（scan，只读）
1. UI → `scan`（读预算 100ms）→ 锁 → 读策略/规则 → revision。
2. `engine.inspect(apply=False)`：
   - 主线程：桌面入口扫描 → 逐图标解析绝对路径 → 读字节 + SHA → 查 `analysis_cache`（键 = path+digest+analysis_policy）。
   - 工作线程池（默认 4）：仅缓存未命中的图标执行 装载→分析→分类→复核（overrides/user rules）；主线程在派发前完成所有 `Gtk.IconTheme` 查询（GTK 非线程安全，GdkPixbuf 装载线程安全）。
   - 主线程：死区决策（纯函数）→ 汇总 rows/groups。
3. 写 `last-scan.json`（0600，原子），返回信封。

### 5.2 应用（apply，排他写）
`expected_revision` 校验 → 事务恢复（若存在日志）→ `inspect()` 产出 changes/manifest →
`baseline.json` 首次落盘 → `transaction.commit()`（日志前置 → 逐文件原子写 → 图标缓存重建 → 日志移除）→
可选主题激活（`settings-pending.json` 前置日志 → `gsettings set` → 回读确认 → 日志移除）→ `last-run.json`。

### 5.3 增量对比
`input_key = sha(path+digest+class+policy)` 命中即整组复用磁盘上未变更的既有 PNG；
未变更文件不进入事务（`before==data` 跳过）；失效源素材保留上一代产物（`retain_previous`）。

## 6. 兼容性承诺（v3.0）

- 协议 v1 线格式、九档尺寸梯队、错误码表、退出码、contracts/*.schema.json **逐字节冻结**。
- `manifest.json` / `baseline.json` / `pending.json` / `config.json`(v2) / `user-rules.json` 磁盘格式不变，旧版本安装状态可直接被新后端接管。
- `policy_sha256` 计算基准随包结构演进（analyzer/renderer 源字节），升级后首轮 apply 全量重渲染一次属预期行为。
- systemd 单元名与占位符（`@HOME@`/`@CONTROL@`）不变；`icon-index-guard.service` 为外部配套单元，缺失时 systemd 静默容忍。

## 7. 已修复的历史缺陷（对照 v2 后端）

1. `control._write_json_file` 忽略 mode → 状态文件以 0600 原子落盘。
2. `_rows_to_groups` 中 `desktop_ids` 恒空 / `auto_class` 永不生效 → 引擎 rows 现携带两字段。
3. 预览 PNG 超限误报 `INTERNAL_ERROR` → 正确返回 `IO_ERROR`。
4. `icon-audit.gallery()` 引用缺失模板 → 审计 CLI 与损坏的 HTML 画廊整体退役（预览协议覆盖其职责）。
5. `version.py` 死文件与常量三处漂移 → `version.py` 唯一事实源。
6. 核心 CLI 无界阻塞锁与 `--check` 空操作 → 核心 CLI 退役，统一走 control 锁预算。
7. overrides.json 用户专属绝对路径 → 迁移至状态目录可选文件。
8. 默认主题硬编码 `Yaru-blue-dark` → gsettings 动态推导，回退 `hicolor`。
9. GSettings 死键（`preview-size`/`preview-background`/`list-filter`）→ 全部接线生效。
10. 手写信号防抖散落两处 → `uiCommon` 统一守卫原语。
11. apply 编排重复实现（面板/维护页）→ `lib/applyFlow.js` 单一实现。
12. 安装/卸载逻辑双份漂移 → `tools/layout.py` 唯一事实源。
