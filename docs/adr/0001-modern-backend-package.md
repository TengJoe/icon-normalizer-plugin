# ADR 0001 — 后端重构为现代 Python 包 `icon_normalizer`

状态：已采纳　日期：2026-10-02

## 背景

v2 后端为三个"冻结"核心脚本（`icon-normalize.py` / `icon-audit.py` / `icon-normalizer.py`）经
`importlib` 链式加载（normalizer → audit → normalize），叠加 `control.py` 等顶层模块：

- 零类型标注、单行紧凑风格，`mypy --strict` 不可用；
- `audit.roots` 靠 monkeypatch 注入夹具目录；核心 CLI 与 control 各持一套锁策略（无界阻塞 vs 有界预算）；
- 审计 CLI 内嵌联系表/HTML 画廊（画廊引用缺失模板，必崩）与硬编码字体路径；
- `version.py` 是死文件，版本常量在三处重复。

## 决策

1. 重构为 `backend/icon_normalizer/` 包，任务规定的四个核心模块落位：
   `core/engine.py`（编排/并发扫描/增量对比）、`core/analyzer.py`（几何分类纯函数）、
   `core/renderer.py`（超椭圆渲染纯函数）、`core/transaction.py`（原子写+日志自愈）；
   另设 `resolver.py`（Gtk3 隔离层）、`desktop.py`、`theme.py`。
2. **数学逐行保真移植**：`analyze/classify/plan/normalize/superellipse/make_plate` 的阈值
   （CORE_ALPHA=200 / FULL_ALPHA=8）、死区公式、4 轮测量校正循环、阴影钳制等与 v2 逐字节等价，
   已验证的参数基线（88% / ±2% / 72% / 九档梯队）不重调。
3. 并发模型：主线程完成全部 `Gtk.IconTheme` 查询（GTK3 非线程安全），工作线程池仅做
   GdkPixbuf 装载（线程安全）+ PIL/numpy 分析与渲染；结果按键收集保证确定性排序。
4. manifest 磁盘格式（version 1）与分析缓存键结构保持不变，旧安装状态零迁移接管；
   `policy_sha256` 基准改为 analyzer/renderer 源字节，升级后首轮全量重渲染一次属预期。
5. 审计 CLI（联系表/画廊）退役；其只读 QA 职责由 `scan` + `preview` 协议操作覆盖；
   由此移除字体路径依赖。

## 后果

- `mypy --strict` 全绿成为 CI 门槛；`desktop.collect(application_dirs=...)` 以参数替代 monkeypatch。
- 修复 `settings-pending.json` 死路径：主题激活现真正前置日志（详见 ADR-0002）。
- 违背 ADR-0001(旧) 的"冻结核心 4 补丁"约束——该约束完成使命退役，测试回归矩阵（12 项）全量继承。
