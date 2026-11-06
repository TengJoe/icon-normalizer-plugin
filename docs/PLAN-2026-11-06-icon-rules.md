# 图标规则可靠性修复与优化方案

**日期**：2026-11-06
**触发事件**：DeepSeek Harness 图标退化为"尖角白方块"
**当前版本**：扩展 1.1.8 / 后台 3.1.6
**目标**：消除"手动规则静默失效"，补齐规则生命周期与可见性

---

## 一、事故复盘（根因链）

| # | 环节 | 事实 |
|---|---|---|
| 1 | 早期 | 源图是"透明底白色鲸鱼"，用户设置覆盖 `class=glyph`（88% 底板 + 72% 内层），键为 `…/hicolor/256x256/apps/chrome-hgiemf….png` |
| 2 | 变化 | DeepSeek Harness（Chrome PWA）更新图标：变为"白底黑鲸鱼"，Chrome 重导出到 **512x512** 目录，SHA 由 `e74cc903…` 变为 `34998f53…` |
| 3 | 失效 | `resolve_rule()` 因 SHA 不匹配返回 `None`；同时规则键（256 目录）与新路径（512 目录）也不再匹配 |
| 4 | 静默 | 无日志、无健康事件、无 UI 提示 → 规则失效**完全不可见** |
| 5 | 退路 | 自动分类判为 `plate-rect`（技术上正确：源图确实是满幅矩形板）→ 保留直角 → 输出尖角白方块 |
| 6 | 发现 | 只能靠用户肉眼发现视觉回归 |

**结论**：SHA 守卫本身是**正确设计**（防止旧手动分类套到新图）；缺陷在于**失效无反馈**与**规则键不稳定**。

---

## 二、修复方案

### FIX-1（P0）规则失效必须可见 ✅ 已实现（后台 1.1.9 起；界面展示 1.1.13 起）

**现状**：`core/engine.py::user_rule()` → `resolve_rule()` 返回 `None`，无任何记录。

**方案**
1. `core/classification.py` 新增 `resolve_rule_ex(rule, digest, source_exists) -> (decision, state)`，`state ∈ {active, stale_source, missing_source, unbound}`；`resolve_rule` 保留为兼容包装。
2. `core/engine.py::user_rule()` 返回 `(decision, rule_state)`；在行记录中写入 `rule_state`、`rule_expected_sha`、`rule_actual_sha`。
3. `health.py` 新增事件类别 `rule_stale`（沿用 `_event()` 的 `changed/failed/recovered` 家族，新增 `degraded` 与 `restored`），写入 `health-events.json`。
4. `last-run.json.warnings` 追加 `{"code": "RULE_STALE", "icon": …, "expected_sha": …, "actual_sha": …}`。
5. `extension/prefs/rulesPage.js`：失效规则行显示警示徽标 + 「源图已变更 · 重新绑定」按钮；`maintenancePage.js` 顶部显示"检测到 N 条规则失效"横幅。

**改动点**：`core/classification.py`、`core/engine.py`、`health.py`、`prefs/rulesPage.js`、`prefs/maintenancePage.js`
**验收**：把源图 SHA 改掉 → 运行一次 → `health-events.json` 出现 `rule_stale`；规则页出现警示；`last-run.json.warnings` 含对应条目。
**工作量**：0.5–1 天

---

### FIX-2（P1）规则改用稳定身份绑定 ✅ 已实现（扩展 1.1.10 / 后台 3.1.8）

**现状**：规则键是**源图绝对路径**，Chrome/PWA 重导出会改尺寸目录（256→512），路径一变即失配。

**方案**
1. 规则条目增加可选字段 `bind`：`{"desktop_id": "chrome-hgiemf…-Default.desktop", "icon_name": "…"}`。
2. `engine` 在检测到"某 desktop_id 的源图路径变化"时（manifest 中保留上一轮 `source_path`），按 `bind.desktop_id` **自动迁移**规则键，并记录 `rule_rebound` 事件。
3. 仅在 `desktop_id` **完全一致**且（若提供）`icon_name` 一致时迁移，避免误关联。
4. 迁移为幂等操作；失败时保留旧条目并记录 `rule_rebind_failed`。

**改动点**：`config_store.py`（schema 校验）、`core/engine.py`（collect 前处理）、`core/classification.py`
**验收**：模拟源图从 256 目录迁到 512 目录 → 规则自动跟上，图标保持 `glyph` 渲染；日志含 `rule_rebound`。
**工作量**：1–1.5 天

---

### FIX-3（P2）统一两套配置的字段名 ✅ 已实现（扩展 1.1.15 / 后台 3.1.13，含 ADR-0005）

**现状**：`overrides.json` 用 `class`，`user-rules.json` 用 `classification`，极易写错。

**方案**
1. 读取时两者都接受（`class` 为 `classification` 的别名），写入时统一输出 `classification`。
2. 两者同时存在且取值不同时 → `INVALID_CONFIG` 警告并列出冲突。
3. `docs/adr/0005-icon-rule-model.md` 明确"portable override（随包发布、按 SHA 绑定）"vs"user rule（本机、可 skip/可绑定）"的职责边界。

**改动点**：`config_store.py`、`core/classification.py`、新增 ADR
**验收**：两种写法均可生效；冲突时报错可读。
**工作量**：0.5 天

---

### FIX-4（P1）新增 `plate-rounded` 类别 ✅ 已实现（扩展 1.1.11 / 后台 3.1.9）

**现状**：`plate-rect` 仅缩放，直角板在圆角生态中突兀（本次事故的直接观感问题）。

**方案**
1. `CLASSES` 增加 `plate-rounded`：缩放至 `target` 后，**保留 RGB、替换 alpha** 为 `superellipse_mask(target_px)`。
2. `classify()` 增加"直角满幅板"判定：`plate-rect` 且四角 alpha>200 且 `source_ratio ≥ 0.95` → 建议 `plate-rounded`（`suggested_class`，不自动改写）。
3. 策略项 `round_sharp_plates`（默认 `false`，新安装向导可开启）；单图标可用规则强制。
4. 预览对话框显示"直角 → 圆角"对比图。

**改动点**：`core/analyzer.py`（CLASSES/classify）、`core/renderer.py`（normalize 分支）、`core/policy.py`、`prefs/previewDialog.js`
**验收**：对白底方块源图选择 `plate-rounded` → 输出为圆角且图案不变形；其余类别渲染零回归。
**工作量**：1 天

---

### FIX-5（P1）`skip` 不应强制还原桌面文件 ✅ 已实现（扩展 1.1.12 / 后台 3.1.10）

**现状**：`_apply_skip()` 会 `rewrite_icon_line(current, record["source_icon"])`，导致"自备图标 + skip"无法实现。

**方案**
1. 规则新增 `keep_desktop_override`（默认 `false`，保持现有语义）。
2. `_apply_skip()` 在该字段为真时跳过桌面文件还原，仅清理主题产物。
3. 设置界面在 skip 开关旁提供「同时保留我的图标指向」复选框，并在文案中说明默认行为。

**改动点**：`core/engine.py::_apply_skip`、`config_store.py`、`prefs/rulesPage.js`
**验收**：`{skip:true, keep_desktop_override:true}` → 桌面 `Icon=` 不变、主题产物被清理；默认行为与 `test_safe_skip.py` 现有断言一致。
**工作量**：0.5 天

---

### FIX-6（P2）失效覆盖的清理入口 ✅ 已实现（报告部分：扩展 1.1.14 / 后台 3.1.12）

**方案**：`overrides.json` 中 SHA 不匹配或源路径不存在的条目，不再静默保留，改为在规则页"已失效（N）"分组展示，提供「清理」与「按当前源图重新绑定」两个操作；清理走 `rules.set` 协议并记录 `rules_cleaned` 事件。
**改动点**：`config_store.py`、`control.py`（新增 `rules.prune`）、`prefs/rulesPage.js`
**工作量**：0.5 天

---

## 三、优化方案

### OPT-1 运行结果可见化
- `maintenancePage.js` 增加"本次运行"卡片：`actions` 分布（shrink/add_plate/keep…）、`planned_file_changes`、耗时、`warnings`。
- 支持展开查看逐图标差异（旧→新动作、分类来源）。

### OPT-2 规则编辑器
- `rulesPage.js` 支持：按应用搜索 → 显示"当前类别 / 来源（auto·user·override）/ SHA / 上次生效时间" → 一键切换类别或重置为自动。
- 展示"该规则为何未生效"（含 `rule_state` 原因码），取代目前只能读 JSON 的体验。

### OPT-3 可选通知
- 仅当**手动规则**进入 `stale_source` 或**重新绑定失败**时发送桌面通知（`Main.notify`），避免打扰。

### OPT-4 诊断增强
- `control.py doctor` 增加 `--rules`：输出规则总数、失效数、未绑定数、最近迁移记录。
- `icon-normalizer status --json` 增加 `rules_health` 字段，便于外部监控。

### OPT-5 文档与测试
- 新增 `docs/adr/0005-icon-rule-model.md`（规则生命周期：bind → active → stale → rebind/reset）。
- `docs/MAINTENANCE.md` 增加"源图变更应急处理"章节（本次复盘作为案例）。
- 新增测试：`test_rule_staleness.py`、`test_rule_rebind.py`、`test_plate_rounded.py`、`test_schema_alias.py`、`test_skip_keep_desktop.py`。

---

## 四、实施顺序与版本

| 里程碑 | 内容 | 版本 | 预估 |
|---|---|---|---|
| M1 | FIX-1 + FIX-6（先让问题可见） | 1.1.9 | 1–1.5 天 |
| M2 | FIX-2 + FIX-3 + ADR-0005（规则模型） | 1.2.0 | 2–2.5 天 |
| M3 | FIX-4 + FIX-5（渲染与 skip 语义） | 1.2.1 | 1.5 天 |
| M4 | OPT-1…OPT-4（体验与可观测性） | 1.3.0 | 3–4 天 |

---

## 五、风险与兼容

| 风险 | 应对 |
|---|---|
| manifest 结构变更 | 读取兼容旧版（缺字段按默认）；写入升 `schema_version`，保留回滚路径 |
| 自动重绑误关联 | 仅按 `desktop_id`+`icon_name` 精确匹配；迁移失败保留原条目 |
| `plate-rounded` 改变既有观感 | 默认关闭；仅对新规则/显式规则生效；预览先看后应用 |
| 协议 v1 冻结（ADR-0002） | 新增字段一律**可选且向后兼容**，不改既有字段语义 |

---

## 六、验收清单

- [ ] 模拟源图 SHA 变化 → `rule_stale` 事件 + 规则页警示 + `warnings` 条目（当前为静默）
- [ ] 源图路径 256→512 迁移 → 规则自动重绑并保持 `glyph` 渲染
- [ ] `plate-rounded` 对白底方块输出圆角且图案无变形
- [ ] `skip + keep_desktop_override` 保留桌面 `Icon=`
- [ ] `class`/`classification` 双写法均生效，冲突可读报错
- [ ] 现有 169 项测试全通过；新增 5 个测试文件
- [ ] 文档：ADR-0005、MAINTENANCE 章节、CHANGELOG 条目
