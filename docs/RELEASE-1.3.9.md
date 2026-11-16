# Icon Normalizer v1.3.9

发布日期：2026-11-17。扩展 **1.3.9**、配套后台 **3.1.21**（渲染核心 3），支持范围为 **GNOME Shell 51**。

## 设置界面重构与视觉打磨

基于 960×720 与 420×560 实机截图审计，保持原生 Libadwaita 风格并重构 5 处细节：

- **「规则」页卡片层级与按钮对齐**：把「保存修改」提前至参数下方，常用/自定义方案与逐图标规则依次排在下方；修复 `actionButton()` 默认 `hexpand: true` 导致「重置」按钮占满半行的问题，并为类别下拉框设置统一最小宽度。
- **「维护」页首屏精简**：顶部的「运行状态」收敛为 5 个核心行（主题、已管理数、自动维护、健康度、上次处理），将检查/更新时间与版本/策略摘要移入「系统与诊断」卡片；960×720 首屏完整露出 3 个主按钮与自动维护开关。
- **「应用图标」页可读性提升**：为 48×48 图标缩略图增加柔和半透明底衬（`.normalizer-app-icon-well`），提升深色裸 Logo 在暗色主题下的可辨识度；列表副标题补齐 `原占比 → 目标%`（例如 `100% → 83%（缩小）`）；去除搜索框在 `ActionRow` 内的双层圆角边框。
- **「效果预览」弹窗**：将「跳过此图标 / 完成」操作栏固定在滚动区下方（420×560 窄屏下无需滚动即可操作）；`≤160 px` 的预览档位改为在 160×160 容器内按 **1:1 原生像素** 居中展示，不再把 32–64px 图标拉伸糊化；修复「改为圆角」按钮过宽问题。
- **双语文案**：同步补全 3 条新界面译文（共 282 条英文译文）。

## 验证

- **21 道质量门**全部通过（`bash tools/verify.sh`：`21/21 PASS`、`0 failed`、`0 skipped`）。
- 实机截图复验：960×720 与 420×560 暗色/亮色页面与预览弹窗均无溢出、无截断。

---

### English summary

- **Rules page**: moved Save actions directly below visual parameters so primary controls stay above the fold; fixed stretched suffix Reset buttons (`set_hexpand(false)`) and aligned classification dropdown widths.
- **Maintenance page**: slimmed the top status card to 5 core rows and moved timestamps/revision/version into a dedicated *System and diagnostics* card so the 3 action buttons and integration switches fit cleanly at 960×720.
- **Apps page**: added subtle rounded icon wells (`.normalizer-app-icon-well`) for dark glyphs, added `source% → target%` ratios in row subtitles, and flattened the double-bordered search entry.
- **Preview dialog**: pinned the Skip/Done footer outside the scroll area for narrow windows, fixed the stretched rounded-plate suffix button, and rendered `<= 160 px` preview sizes at 1:1 native scale.
- **Verification**: all **21 quality gates** pass (`bash tools/verify.sh`).
