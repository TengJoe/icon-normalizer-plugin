# ADR-0005 图标规则模型

状态：已接受（2026-11-06）

## 背景

插件有两套"改写某个图标分类"的机制：

| 机制 | 存放 | 键 | 生命周期 |
| --- | --- | --- | --- |
| reviewed override | `overrides.json`（随包 + 本机） | 图标（名字或绝对路径） | 人工评审，随版本发布 |
| user rule | `user-rules.json`（本机） | 图标 ID（SHA-256 of icon string） | 用户设置，可 skip |

两者都按 `source_sha256` 绑定源图指纹。指纹变化（应用更新图标）后规则失效，但历史上没有任何提示，导致"图标悄悄退回自动分类"。

## 决策

1. **字段别名**：`class`（override 惯用）与 `classification`（rule 惯用）等价；两者同时出现且取值不同时判为 `invalid`，并以 `conflicting_alias` 说明原因，不静默择一。
2. **规则状态**：`active` / `stale_source` / `unbound` / `invalid` / `none`，随每条运行记录写入 `rule_state`，失效状态同时进入 `rule_warnings` 与 `degraded` 健康事件。
3. **匹配顺序**：协议 SHA 键 → 原始图标字符串 → **唯一文件名回退**（用上一轮清单记录的源路径还原文件名）。文件名候选多于一条时拒绝匹配。
4. **skip 语义**：默认在跳过时还原或删除生成的启动器；`keep_desktop_override: true` 时仅释放记录、保持启动器原样。
5. **失效报告**：reviewed override 的源图存在但指纹不符时记为 `OVERRIDE_STALE_SOURCE`；图标未安装的 portable 条目不报告。

## 影响

- 协议 v1 保持冻结：新增字段一律可选、向后兼容；`resolve_rule()` / `classify_source()` 签名不变。
- 分析缓存键包含策略、覆写、规则与 `classification.py` / `analyzer.py` 源码指纹，规则或分析逻辑变化会自动重算。
- 渲染核心版本独立递增（当前 3），预览缓存随之失效。

## 未决

- 失效规则的**自动重绑**目前只按文件名；若应用同时改文件名与目录，仍需人工确认。
- 规则编辑器的界面展示（规则来源、指纹、失效原因）尚未实现。
