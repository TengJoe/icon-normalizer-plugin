# Reviewer note — Icon Normalizer (1.2.0)

Bilingual statement of facts for the GNOME Extensions review. Copy the English part
into a review comment or the upload notes if a reviewer asks.

## English

**Declared support.** `shell-version: ["51"]` is intentional. The package was written,
built and exercised on GNOME Shell 51.0, and 51 is the current stable release.
The experimental Shexli rule `EGO-M-004` flags it because the local tool release
(0.2.1, the newest on PyPI) only ships API data for GNOME 49/50 and hard-codes
`major > 50` as "implausible future". Several published extensions show the same
advisory finding on their review pages (Dash to Dock 107, Spotlight 2026.15,
Kiwi Menu 1.6.5). Declaring "50" instead would mark the extension incompatible on
GNOME 51 and lock users out, so the declaration stays.

**Companion backend.** The extension is a control panel for a separately installed,
user-level Python backend. The backend is what performs icon normalization; the
extension never downloads anything, never runs as root, and never touches the
filesystem outside the user's home, the user icon theme, and the user systemd units.
Review guidelines discourage external processes; here the split is deliberate:

- the image pipeline needs GTK 3 / GdkPixbuf / Pillow / NumPy, which must not be
  loaded into the Shell process, and the preferences window uses GTK 4 / Libadwaita;
- the Shell-side code therefore only spawns a fixed argv array and talks JSON over
  stdin/stdout; read requests are cancellable and interrupted writes finish safely.

A ZIP-only installation contains no backend and displays "backend not installed"
with a pointer to the release tarball. That is intended behaviour, not a broken state.

**Package contents.** The ZIP ships readable GJS, symbolic SVG, CSS, metadata, the
GPLv3 licence and a compiled GSettings schema — no binaries, no minified code.

**Changes since 1.1.1 (all reviewed in this repository).**

- **Icon rules became first-class.** Every run now reports a per-icon `rule_state`
  (`active`, `stale_source`, `unbound`, `invalid`, `none`) plus a `rule_warnings`
  list, and `status` exposes a `rules_health` summary. Nothing new leaves the machine;
  this is local diagnostics only.
- **New GSettings keys** (both belong to the extension's own schema, no system settings):
  `notify-rule-warnings` (boolean, default `true`) turns the optional desktop
  notification on or off; `notified-rule-warnings` (integer, default `0`) remembers
  the last notified warning count so a Shell restart does not repeat the same notice.
- **New rendering class `plate-rounded`**: keeps a source icon's artwork and replaces
  its silhouette with a squircle, for square-cornered backplates that look out of place
  on a rounded desktop grid. It is opt-in per icon; automatic classification is unchanged.
- **Rule matching** also falls back to a unique file name when an application re-exports
  identical artwork into another size directory, and `rules.set {reset:true}` clears the
  matching machine-local override as well.
- **Housekeeping**: unclaimed PNGs inside the plugin's *own* icon theme are removed on
  the next run; deletions participate in the existing transaction and roll back with it.

No new permissions, no network access and no changes to the backend's command surface
beyond the optional fields described above. Verification: 253 backend tests and five
frontend suites pass; release, privacy and output-quality audits are documented under
`docs/`.

## 简体中文

**shell-version 声明。** `["51"]` 是有意为之：扩展在 GNOME Shell 51.0 上开发、构建并实测，
51 是当前稳定版。Shexli 的实验性规则 `EGO-M-004` 会标记它，是因为本地工具版本（0.2.1，
PyPI 最新）只带 GNOME 49/50 的 API 数据，并把 `major > 50` 硬编码为"不可能的将来"。
多个已发布扩展（Dash to Dock 107、Spotlight 2026.15、Kiwi Menu 1.6.5）的审核页也有同样提示。
若改成 "50" 会让扩展在 GNOME 51 上被判为不兼容，因此保持声明不变。

**配套后端。** 扩展是"独立安装的用户级 Python 后端"的控制面板：归一化由后端完成；扩展不下载任何内容、
不以 root 运行、不触碰用户主目录之外的系统文件（仅用户图标主题与用户级 systemd 单元）。
拆分是刻意的：图像管线需要 GTK 3 / GdkPixbuf / Pillow / NumPy，不能载入 Shell 进程；
设置界面用 GTK 4 / Libadwaita。Shell 侧只启动固定参数数组并通过 stdin/stdout 传 JSON。
仅安装 ZIP 时会显示"后端未安装"并指向发行包，这是预期行为。

**包内容。** ZIP 只含可读的 GJS、symbolic SVG、CSS、metadata、GPLv3 许可证与编译后的 GSettings schema，
没有二进制、没有压缩混淆代码。

**自 1.1.1 以来的变更（均在本仓库可查）。**

- **图标规则成为一等公民**：每次运行都会报告逐图标的 `rule_state`（`active` / `stale_source` /
  `unbound` / `invalid` / `none`）与 `rule_warnings` 列表，`status` 提供 `rules_health` 汇总。
  纯本地诊断，不向外发送任何数据。
- **新增 GSettings 键**（都属扩展自己的 schema，不改系统设置）：`notify-rule-warnings`（布尔，默认 true）
  控制是否发送可选的桌面通知；`notified-rule-warnings`（整数，默认 0）记录上次已提醒的告警数，
  避免 Shell 重启后重复提醒。
- **新增渲染类别 `plate-rounded`**：保留源图图案、把轮廓替换为圆角（squircle），用于"满幅直角底板"；
  逐图标显式启用，自动分类逻辑不变。
- **规则匹配**增加"唯一文件名回退"：应用把同一图案重导出到另一个尺寸目录时规则仍可接续；
  `rules.set {reset:true}` 会同时清理本机同名的 reviewed override。
- **清理**：插件**自有**图标主题内未被引用的 PNG 会在下一轮删除，删除同样纳入事务、可回滚。

没有新增权限、没有网络访问，后端命令面除上述可选字段外没有变化。验证：后端 253 项测试、
前端 5 组套件全部通过；发布、隐私与产出质量审计记录在 `docs/` 下。
