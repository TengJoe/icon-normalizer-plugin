# Icon Normalizer v1.3.10

发布日期：2026-11-23。扩展 **1.3.10**、配套后台 **3.1.22**（渲染核心 3，渲染结果不变），支持范围为 **GNOME Shell 51**。

## 已排除图标显示排除原因

巡查发现「应用图标」页「已排除」胶囊下的 2 个分组（`ibus-setup`、`input-keyboard`）没有任何原因，并统一显示为「残留入口」。实际上它们是系统有意在 GNOME 中隐藏的入口（`NotShowIn=GNOME`、`OnlyShowIn=KDE;LXQt`），不是卸载残留。

- `scan` 的 `excluded` 分组新增 `reason` 字段，值与 `.desktop` 可见性判定一致：`hidden`、`no_display`、`only_show_in_other_desktop`、`not_show_in_current_desktop`、`tryexec_missing`、`exec_missing`、`invalid_exec`。Python 后台与 GJS 引擎同步输出。
- 副标题先写原因，再写入口文件；只有程序缺失或 Exec 无法解析时才称为「残留入口」。
- 协议只新增字段，旧前端忽略即可，无破坏性变化；渲染算法与图标输出不变。

## 验证

- **21 道质量门**全部通过（`bash tools/verify.sh`）。
- 新增 `tests/backend/test_excluded_reason.py`（2 项）与 `stateModel` 原因映射测试。

---

### English summary

- `scan` now reports a `reason` for every `excluded` group, taken from the desktop-entry visibility check (Python worker 3.1.22 and the GJS engine alike).
- The Apps page explains why a group is excluded (e.g. *Hidden on this desktop (NotShowIn)*) and only calls an entry a *leftover launcher* when its program is missing.
- Additive protocol field only; rendering is unchanged. All **21 quality gates** pass.
