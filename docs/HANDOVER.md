# 接手说明 / Handover

更新时间：2026-11-06 · 扩展 **1.1.33** / 后台 **3.1.20** / 渲染核心 **3**

## 这是什么

GNOME Shell 51 扩展 + 用户级 Python 后端：把 Dock / 应用网格里的图标统一到同一视觉占比（默认 83% ± 2%，内层 70%），按需补底板，生成 16–512 px 九档图标到专属主题 `DockNormalized`。

## 一分钟上手

```sh
git clone https://github.com/TengJoe/icon-normalizer-plugin && cd icon-normalizer-plugin
python3 tools/install.py --assume-yes     # 安装扩展 + 后台 + systemd 用户单元
python3 tools/build.py                    # 构建 dist/ 产物（ZIP + tar.gz + 清单）
python3 tools/release_audit.py --submission && python3 tools/privacy_audit.py

# 一条命令跑完全部 13 个质量门（--quick 跳过需要显示服务的 Q8/Q10）
bash tools/verify.sh
bash tools/verify.sh --quick
```

脚本会打印每道门的结果并统计，任一失败即返回非零。2026-11-06 实测：**13/13 通过**；在**全新克隆**里执行 `npm ci --ignore-scripts && bash tools/verify.sh --quick` 同样 **11/11 通过**（仓库自包含，无遗漏文件）。

构建是**可复现**的：同一份源码（含全新克隆）产出的 ZIP 与 tar 的 SHA-256 完全一致。

## 目录地图

| 目录 | 内容 |
| --- | --- |
| `backend/icon_normalizer/core/` | 分析、分类、渲染、引擎（事务与清单） |
| `backend/icon_normalizer/control.py` | 协议操作实现（`status`/`scan`/`apply`/`rules.set`/`doctor`…） |
| `extension/prefs/` | 设置界面：规则页、应用页、维护页、预览弹窗 |
| `extension/shell/indicator.js` | 顶栏指示器（含规则失效通知） |
| `extension/shared/stateModel.js` | 纯函数状态模型（筛选、徽标、摘要） |
| `tests/backend/` | 后端 253 项（含 `harness.py` 沙箱） |
| `tests/frontend/` | 前端 5 组套件（VM 加载真实生产代码） |
| `docs/` | 计划、ADR、审计、手册、每版 RELEASE、发布契约 |

## 图标规则的完整生命周期

```
分类 ──glyph / plate-rect / plate-rounded / plate-circle / artwork
  │
  ├─ 自动分类（analyze → classify）
  └─ 手动：user rule（user-rules.json）或 reviewed override（overrides.json）

绑定 ── 规则的 source_sha256 = 当时源图指纹
  │
失效 ── 应用换图 → 指纹不符 → rule_state = stale_source
  │        （若只是换了尺寸目录，按唯一文件名自动接续）
  ├─ 报告：rule_warnings + rules_health + degraded 健康事件 + 顶栏通知（可关）
  ├─ 修复：维护页详情弹窗一键重置 / 规则页下拉改类别
  └─ 恢复：下一轮无告警时补写 recovered 事件
```

## 已知限制

1. **最小尺寸取整**：16px 画布上 1px = 6.25%，个别图标与目标差 1px（已记录在 `docs/AUDIT-2026-11-06.md`）。
2. **文件名回退**：只在候选唯一时生效；应用同时改名又改目录时仍需人工确认。
3. **商店版本**：`extensions.gnome.org` 的公开版本落后于仓库，上传需要人工在浏览器完成（见下）。

## 待办（需要人工）

- 上传 `outputs/icon-normalizer-github/icon-normalizer@joeydeng.local.zip` 到 `https://extensions.gnome.org/extension/11143/`；备注可粘贴 `REVIEWER-NOTE.md` 的英文部分。
- 注意：上传新版本会**自动驳回**当前待审版本（平台行为，非审核拒绝）。

## 想深入了解

| 主题 | 文档 |
| --- | --- |
| 为什么这样设计规则 | `docs/adr/0005-icon-rule-model.md` |
| 规则失效怎么排查 | `docs/MAINTENANCE.md` |
| 产出质量实测 | `docs/AUDIT-2026-11-06.md` |
| 完整修复计划与进度 | `docs/PLAN-2026-11-06-icon-rules.md` |
| 每版改了什么 | `CHANGELOG.md` + `docs/RELEASE-*.md` |
