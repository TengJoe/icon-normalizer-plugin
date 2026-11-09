# Icon Normalizer v1.3.4

发布日期：2026-11-09。扩展 **1.3.4**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。

## 修复：切换源图标主题时「跟随」不生效

`维护 → 跟随图标主题` 默认开启，但纯 GJS 引擎的 `theme.sync` 只做了重新渲染，**没有先采纳用户新选中的源主题**。结果：

- 用户把图标主题从 `Yaru` 换成 `Adwaita`；
- 扩展收到 `changed::icon-theme` 并调用 `theme.sync`；
- 引擎仍然以 `Yaru` 为源重新生成 —— 界面看起来"什么也没发生"。

实测（切换后读取 `config.json`）：

```
切换前 base_theme: Yaru
theme.sync.source_theme: Yaru      ← 应为 Adwaita
切换后 base_theme: Yaru            ← 跟随失效
```

本版本补上与 Python 端 `theme_follow.transition_policy()` 等价的行为：先校验并采纳新源主题，再重新生成。

### 采纳规则（与后端一致）

| 情形 | 行为 |
| --- | --- |
| 选中 `DockNormalized`（叠加主题自身） | 不采纳 |
| 与当前源主题相同 | 不采纳 |
| 主题未安装（搜索路径下无 `index.theme`） | 不采纳 |
| 名称非法（`..`、超长、含特殊字符） | 不采纳 |
| 还没有首次运行（无 manifest） | 不采纳 —— 此时不存在可跟随的叠加层 |
| 跟随开关关闭 | 不采纳，且不触发同步 |

## 新增测试

`tests/gjs/control.test.js` 增加一条用例，覆盖上述全部六种情形：采纳成功后 `config.json` 的 `base_theme` 确实改变，三次拒绝后保持不变，关闭跟随后不再同步。

## 验证

- 20 道质量门全部通过（`bash tools/verify.sh`）。
- GJS 单元测试 14 项（控制层）全过。
