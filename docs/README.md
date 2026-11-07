# 文档索引 / Documentation index

[使用说明（中文）](../README.md) · [User guide (English)](../README.en.md) · [贡献指南 / Contributing](../CONTRIBUTING.md) · **[接手说明 / Handover](HANDOVER.md)**

## 使用说明 / Usage

| 文档 / Document | 内容 / Contents | 语言 / Language |
| --- | --- | --- |
| [README](../README.md) | 安装、使用、自定义方案、主题跟随与恢复 | 简体中文 |
| [English README](../README.en.md) | Installation, usage, profiles, theme following, and recovery | English |
| [v1.3.3 发布说明 / Latest release notes](RELEASE-1.3.3.md) | 当前版本：控制层协议接缝补齐 / Current: control-layer protocol seams completed | 中文 / English |
| [v1.3.1 发布说明](RELEASE-1.3.1.md) | 引擎加固——并发互斥、安全回滚、idle 分片 / Engine hardening | 中文 / English |
| [v1.3.0 发布说明](RELEASE-1.3.0.md) | 纯 GJS 内嵌引擎与零外部依赖 / Pure GJS in-process engine | 中文 / English |
| [v1.2.0 发布说明](RELEASE-1.2.0.md) | 规则可靠性 / Rule reliability | 中文 / English |
| [v1.1.51 发布说明](RELEASE-1.1.51.md) | 开发过程版本（未公开发布）/ Development-only version | 中文 / English |
| [v1.1.50 发布说明](RELEASE-1.1.50.md) | 文档与工具一致性 / Documentation and tooling consistency | 中文 / English |
| [v1.1.30 发布说明](RELEASE-1.1.30.md) | 规则生命周期文档写入 README / Rule lifecycle documented in the READMEs | 中文 / English |
| [v1.1.29 发布说明](RELEASE-1.1.29.md) | 健康事件闭环（degraded → recovered） / Health events close the loop | 中文 / English |
| [v1.1.27 发布说明](RELEASE-1.1.27.md) | 孤儿图标清理 / Stale artwork cleanup | 中文 / English |
| [v1.1.8 发布说明](RELEASE-1.1.8.md) | 历史版本 / Previous release | 中文 / English |
| [v1.1.1 发布说明 / Release notes](RELEASE-1.1.1.md) | 首个公开版本的下载、验证与支持范围 / Downloads, validation, and scope | 中文 / English |

完整版本记录见 [CHANGELOG](../CHANGELOG.md)；每个版本都有对应的 `RELEASE-<version>.md`。 / Every version has a matching `RELEASE-<version>.md`.

## 开发与发布 / Development and releases

前端维护与资源释放约定见 [MAINTENANCE.md](MAINTENANCE.md)。

| 文档 / Document | 内容 / Contents | 语言 / Language |
| --- | --- | --- |
| [贡献指南 / Contributing](../CONTRIBUTING.md) | 问题反馈、开发检查与写作规范 / Issue reports, checks, and writing conventions | 中文 / English |
| [架构 / Architecture](../ARCHITECTURE.md) | 模块边界、进程隔离、事务与数据流 | 简体中文 |
| [协议 / Protocol](../PROTOCOL.md) | 协议 v1、14 项操作、错误码与并发规则 | 简体中文 |
| [验收清单 / Release checklist](CHECKLIST.md) | 自动检查、手动验收与恢复步骤 | 简体中文 |
| [规则可靠性计划 / Rule reliability plan](PLAN-2026-11-06-icon-rules.md) | FIX-1…6 与 OPT-1…5 的问题、方案与验收 | 简体中文 |
| [产出质量审计 / Output quality audit](AUDIT-2026-11-06.md) | 625 个产出 PNG 的占比、居中度与圆角审计 | 简体中文 |
| [GJS 影像可行性 / GJS imaging feasibility](PROTOTYPE-gjs-imaging.md) | 移植到 GJS 的实测数据：几何一致、性能可接受 | 简体中文 |
| [GNOME Extensions 提交说明 / Submission notes](SUBMISSION.md) | Companion architecture, review boundaries, and submission checks | English |
| [发布记录 / Changelog](../CHANGELOG.md) | 版本变更与开发历史 | 简体中文 |

## 架构决策记录 / Architecture decision records

ADR 记录决策当时的背景与取舍。兼容声明、文件布局和操作清单以当前版本的 README、架构与协议文档为准。

ADRs describe the context and tradeoffs at the time of each decision. Use the current README, architecture, and protocol for supported versions, layout, and operations.

| ADR | 决策 / Decision | 语言 / Language |
| --- | --- | --- |
| [0001](adr/0001-modern-backend-package.md) | 后台 Python 包化 | 简体中文 |
| [0002](adr/0002-protocol-v1-frozen.md) | 协议兼容与事务加固 | 简体中文 |
| [0003](adr/0003-frontend-esm-libadwaita.md) | 前端 ESM 与 Libadwaita；历史兼容范围 | 简体中文 |
| [0004](adr/0004-build-and-lifecycle.md) | 打包、安装与生命周期 | 简体中文 |
| [0005](adr/0005-icon-rule-model.md) | 图标规则模型：两套机制、匹配顺序、skip 语义与失效报告 | 简体中文 |
| [0006](adr/0006-reliability-boundaries.md) | 轻量诊断、所有权冲突与维护健康状态 | 简体中文 |
| [0007](adr/0007-ownership-preconditions.md) | 提交前置状态与持久配置故障 | 简体中文 |
| [0008](adr/0008-gjs-only-engine.md) | 纯 GJS 内嵌引擎与零外部依赖架构 | 简体中文 |
| [0005](adr/0005-profiles-and-theme-follow.md) | Named profiles and source-theme migration | English |
