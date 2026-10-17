# 1.1.5 本地候选版 / Local candidate

扩展 1.1.5、后台 3.1.4、API 1、渲染核心版本 2。这是本地优化版，未创建公开 Release。

## 行为范围

- 扩展启用时监听 GNOME 深浅色、强调色和图标主题。将 Ubuntu 的 `default` 明确为 `prefer-light`，解决本机 Codex 从深色返回浅色时未收到明确浅色偏好的兼容问题。应用仍需设置为跟随系统。
- GTK 同步仅管理标准 Yaru 系列，按 GNOME 强调色与深浅色选择已安装 GTK 3 主题；自定义 GTK 家族不被替换。它不修改应用自己的主题设置。
- `DockNormalized` 激活且图标跟随、自动维护已开启时，后台将标准 Yaru 来源迁移到对应的已安装强调色/深浅色版本。其他图标家族仅保留原有同族深浅色配对。
- 缺失或未知强调色不会强行选择未安装主题；原始系统资源只读。策略、baseline、生成文件仍走同一事务和所有权校验。
- 停用扩展会移除 GTK 监听，不回写旧颜色；systemd 图标维护状态不变。重新启用时对齐当前系统状态。

## 安装与验证

从完整源码包解压后运行 `python3 tools/install.py --assume-yes`。安装器保留安装快照和既有 timer/path 状态。正在运行的 GNOME Shell 可能缓存旧 JS 模块；新的前端代码在下次登录后确定加载，后台按请求启动，升级后即使用新代码。无需为升级强制注销。

源码包含后台事务/回滚/外部修改保护测试、真实 GJS 测试、独立 dconf 会话的跨进程切换测试，以及隔离 GNOME Shell 51 的切换和启停测试。公开商店审核及其他 GNOME 版本不在验证范围。

## English

Local candidate only: extension 1.1.5, backend 3.1.4. Standard Yaru GTK and icon variants follow GNOME accent and color-scheme preferences when installed. Custom GTK and icon families keep their selected colors. The Shell promotes Ubuntu's `default` preference to explicit `prefer-light`; applications must use their system theme option.

Icon migrations retain transactional updates, ownership checks and activation guards. Disabling the extension disconnects GTK listeners without restoring an older preference or changing background maintenance. The installer preserves snapshots and trigger states. Cached Shell modules may require the next login; the separately launched backend uses upgraded code immediately. Both ZIP and full source archives are checked byte-for-byte against current source before replacing existing build artifacts.
