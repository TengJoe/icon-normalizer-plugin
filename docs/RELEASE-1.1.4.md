# Icon Normalizer v1.1.4

发布于 2026-10-16。扩展 **1.1.4**，配套后台 **3.1.3**，实测支持 **GNOME Shell 51**。

[简体中文](#简体中文) · [English](#english) · [GitHub Release](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.4)

## 简体中文

### 本次更新

- **启发式同族变体动态配对（Heuristic Variant Resolution）**：
  解决 Linux 桌面在切换深浅色外观时，生成图标主题底层继承来源（Inherits）与当前桌面风格脱节的问题。采用无硬编码的启发式后缀探测规则（兼容 `-dark`、`-Dark`、`_dark`、`-light` 等主流约定），动态检验物理磁盘上的 `index.theme`，自适应匹配同族对等变体。广泛适配包括 Ubuntu Yaru、Papirus、Tela、Colloid、Breeze、WhiteSur、Humanity 等海量社区主流图标家族。
- **深浅色偏好自动感知**：
  后台支持检测 `org.gnome.desktop.interface color-scheme`。在 `DockNormalized` 保持激活的前提下，随系统深浅色切换自动将底层继承来源迁移至对应深/浅变体，UI 丝滑无感知。
- **单体主题安全回退**：
  若当前主题为单体主题（如 Adwaita、HighContrast 等没有深浅分立），动态探测不到对等变体时自动保持原样，保证 100% 稳定与向后兼容。
- **事务与状态自洽**：
  变体迁移完整接入现有事务日志、baseline、config 与 manifest 校验，保持 `DockNormalized` 持续激活。

### 下载与升级

| 文件 | 用途 |
| --- | --- |
| `icon-normalizer-plugin-1.1.4.tar.gz` | 完整安装或升级，包含扩展、后台与安装工具 |
| `icon-normalizer@joeydeng.local.zip` | 仅扩展前端，不包含 Python 后台修复 |
| `DIST_MANIFEST.json` | 组件版本与包 SHA-256 |
| `SHA256SUMS` | 下载完整性校验 |

要获得完整深浅色变体联动功能，请使用完整发行包。准备 [README](../README.md#兼容与依赖) 中的运行依赖，将 tar.gz 与 `SHA256SUMS` 放在同一目录，以普通用户执行：

```bash
sha256sum --ignore-missing -c SHA256SUMS
# 确认校验显示 OK 后，继续：
tar -xzf icon-normalizer-plugin-1.1.4.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

### 验证与范围

- 后端 184 项测试（含新增启发式变体解析单元测试与端到端沙箱集成测试），全部通过。
- 安装/卸载/回滚测试与静态类型检查通过。

---

## English

### Highlights

- **Heuristic Variant Resolution for Dark/Light Themes**:
  Solves the inconsistency between the underlying fallback theme (`Inherits`) and desktop appearance when toggling light/dark mode. Implements generic, zero-hardcoding heuristic suffix matching (`-dark`, `-Dark`, `_dark`, `-light`, etc.) validated against real `index.theme` files on disk. Seamlessly supports popular theme families including Ubuntu Yaru, Papirus, Tela, Colloid, Breeze, WhiteSur, Humanity, etc.
- **Color-Scheme Awareness**:
  Detects `org.gnome.desktop.interface color-scheme` changes. Automatically shifts `DockNormalized`'s base fallback theme between light and dark sibling variants while keeping `DockNormalized` active.
- **Graceful Single-Theme Fallback**:
  Themes without dark/light pairs (such as Adwaita, HighContrast) safely keep their original source without side effects.
- **Transactional Consistency**:
  Transitions adhere to existing atomic transactions, baseline records, and manifest verification.

### Downloads

| File | Purpose |
| --- | --- |
| `icon-normalizer-plugin-1.1.4.tar.gz` | Complete installation or upgrade, including the frontend, backend, and installer |
| `icon-normalizer@joeydeng.local.zip` | Extension frontend only |
| `DIST_MANIFEST.json` | Component version manifest with package SHA-256 digests |
| `SHA256SUMS` | Integrity checksums |
