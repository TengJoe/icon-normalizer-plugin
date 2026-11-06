# Icon Normalizer v1.3.0

发布日期：2026-11-07。扩展 **1.3.0**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。API 版本 1，渲染核心版本 3。

## 架构突破：纯 GJS 内嵌引擎与零外部依赖

自此版本起，Icon Normalizer 彻底告别了对外部 Python 后台与 systemd 用户守护进程的依赖。
所有图标分析、Lanczos3 图像重采样、合成渲染、主题目录管理、事务回滚与 XDG 图标解析全部由内嵌的纯 GJS 引擎完成。

### 核心收益

1. **零外部依赖，一键即用**：从 extensions.gnome.org 安装后即可直接运行，无需在终端安装 Python、NumPy、Pillow 或配置 systemd 服务。
2. **消除跨进程 IPC 开销**：消除所有 Subprocess 调用与管道 JSON 序列化，首屏载入与状态切换更轻更快。
3. **数学级严格等价**：自研 Lanczos3 重采样核心 + alpha 预乘，经过全量 144 组对比实测，占比偏差与原 Python 后端保持 **0.00 px** 绝对一致。

### 质量把关

- **19 道质量门全量通过**（`bash tools/verify.sh`）：
  - 包含 61 项 GJS 内嵌引擎单测（Q18）；
  - 包含 144 组 GJS vs Python 跨架构渲染等价性对拍（Q19）；
  - 包含真实 GTK 运行时测试与 GNOME Shell 51 独立沙箱验收。

详见架构决策记录 [ADR-0008](adr/0008-gjs-only-engine.md)。
