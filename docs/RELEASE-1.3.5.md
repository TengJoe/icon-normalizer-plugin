# Icon Normalizer v1.3.5

发布日期：2026-11-09。扩展 **1.3.5**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。

## 新增：跟随系统的深色偏好与强调色

1.3.4 修好了「切换源图标主题时跟随」，但**深色模式与强调色变化仍不会带动叠加层**——这是纯 GJS 相对 Python 后端最后一个明确缺失的用户功能（Python 有 `theme_follow.resolve_system_variant()`）。

本版本把该逻辑移植到 `extension/lib/variants.js`，语义与后端逐条对齐：

| 规则 | 说明 |
| --- | --- |
| 主题名解析 | `Yaru-blue-dark` → stem `Yaru-blue`、分隔符 `-`、变体 `dark`；`black/white` 分别视为 dark/light |
| 仅 Yaru 跟随强调色 | 强调色只映射到 `Yaru` 家族（`teal→prussiangreen`、`green→olive`、`orange→` 纯 Yaru …） |
| 其它主题族 | 只做明暗兄弟解析，不会因为强调色跳到无关主题 |
| 未安装的变体 | 一律拒绝，保持当前源主题（绝不"发明"一个主题） |
| 何时生效 | 仅在**叠加层正是当前图标主题**时；用户显式选择了别的主题时不介入 |

### 实测（真实 GNOME 51 会话数据）

```
当前系统: color-scheme=prefer-dark  accent-color=blue  icon-theme=DockNormalized
初始 base_theme: Yaru
切到深色      : adopted=Yaru-blue-dark   base=Yaru-blue-dark
切回浅色      : adopted=Yaru-blue        base=Yaru-blue
强调色改绿    : adopted=Yaru-olive       base=Yaru-olive
未知强调色    : adopted=null             base=Yaru-olive（保持不变）
```

## 配套改动

- `extension.js` / `prefs.js` 的宿主适配层新增 `colorScheme()` 与 `accent()` 两个读取器（`accent-color` 在旧 schema 上不存在，读取失败返回 `null`）。
- 扩展此前已在 `changed::accent-color` 上触发 `theme.sync`，现在这条链路才真正有意义。

## 测试

- 新增 `tests/gjs/variants.test.js`（5 项）：主题名解析、明暗兄弟、未安装变体、Yaru 强调色映射、非 Yaru 主题族边界。
- `tests/gjs/control.test.js` 新增一条端到端用例，走完「深色 → 浅色 → 强调色 → 未知强调色」四条路径并断言 `config.json` 的持久值。
- Q18 现在覆盖 10 个 GJS 测试文件。

## 验证

- 20 道质量门全部通过（`bash tools/verify.sh`）。
