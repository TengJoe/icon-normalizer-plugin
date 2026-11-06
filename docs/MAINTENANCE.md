# 前端维护指南 / Frontend maintenance

目标环境为 GNOME Shell 51。GTK 4 / Libadwaita 设置窗口独立于 Shell，Python 后台保持 GTK 3 图像处理边界。
This frontend targets GNOME Shell 51. Preferences and image processing run in separate processes.

## 模块与资源所有权 / Modules and ownership

| 模块 | 资源与释放位置 |
| --- | --- |
| `extension.js` | `enable()` 创建设置监听、请求作用域与主题去抖；`disable()` 断开监听、移除定时器、关闭作用域并销毁顶栏。初始化失败走同一清理路径，因此保留异常回滚。 |
| `shell/indicator.js` | 创建顶栏与状态目录监视器；`destroy()` 取消监视、移除去抖并销毁菜单。 |
| `shared/backendClient.js` | 每个请求持有子进程与超时；`communicate_utf8_finish()` 回收结果，settle 移除超时与作用域登记。 |
| `prefs/requestScope.js` | `WindowScope` 绑定父窗口关闭信号，基于 `Gio.Cancellable` 判断取消；关闭后断开信号并移除重试延迟。 |
| `prefs/preferences.js` | 创建三页，窗口关闭时移除语言 idle/监听，调用各页 `destroy()`。 |
| `prefs/previewDialog.js` | 每个对话框持有独立作用域，每次预览使用新的读取作用域；新尺寸取消旧请求，关闭对话框或父窗口取消读取。 |
| `prefs/uiCommon.js` | 仅设置窗口使用的 GTK 工具；尺寸观察函数返回清理函数，由应用页销毁时调用。自适应按钮布局观察所属窗口，由请求作用域在关闭时移除 tick；控件自身信号随控件销毁。 |

`shared/` 禁止导入 Gtk/Gdk/Adw/St/Clutter/Meta/Shell 等界面库。只属于 Shell 或 Preferences 的代码放入对应目录。
Shared modules must stay independent of either UI toolkit. Keep all process-specific code in `shell/` or `prefs/`.

## 请求关闭行为 / Closing requests

1. 读取请求（status、doctor、scan、preview、profiles.list）关闭时终止子进程，但仍执行异步 finish 回收。
2. 写入请求关闭时返回取消提示；已启动的子进程继续安全完成并被回收，不发送 SIGKILL。
3. 每次 await 后先检查作用域取消状态，再更新控件或发起下一步骤。关闭保存窗口后，已开始的 configure 可以完成，但不会继续启动 apply。
4. `try/finally` 中的界面恢复同样受取消检查约束。
5. 开关同步、请求去重、保存中等业务标志仍有用途；不使用 `_closed`/`_destroyed` 代替取消与资源释放。

Cancellation stops reads and continuations. It never kills a running write. Always check cancellation after awaiting a backend result, including before updating UI in a finally block.

## 验证 / Validation

```bash
npm ci --ignore-scripts
npm run lint
npm run test:logic
node tests/frontend/syntax-check.mjs
python3 tests/frontend/test_runtime.py
python3 tests/frontend/headless_shell.py
python3 -m unittest discover -s tests/backend -p 'test_*.py'
python3 -m unittest discover -s tests/installation -p 'test_*.py'
python3 tools/build.py
python3 tools/release_audit.py --submission --archive dist/icon-normalizer@joeydeng.local.zip
```

`lifecycle-smoke.mjs` 使用真实 GTK 和临时 HOME 中的延迟后台，验证关闭预览、最新尺寸优先、写入中关闭、停止后续 apply 和重新打开读取新状态。
The lifecycle fixture delays actual subprocess requests in a disposable home. It does not modify the user's desktop or settings.

## 发布边界 / Publication boundaries

作者、许可证、项目与反馈入口保留；1.1.8 不包含捐赠元数据、Sponsor 配置、收款码或支付界面。
Author attribution, license, project and issue links remain. Version 1.1.8 contains no donation UI or payment assets.

本项目使用 AI 辅助生成和重构。维护者需要本人能够解释、调试和维护提交的 JavaScript；自动测试不能证明这项能力。公开提交前须审阅实际差异，并如实回应审核者。外部 Python 后台是否被 EGO 接受仍由审核者判断，代码整理和测试通过不表示审核批准。
AI assistance is used in this project. The submitter must personally understand, debug and maintain the code. Automated checks and this guide do not establish that ability or guarantee EGO approval.

Shell 缓存模块；安装新文件不表示当前会话已经重载。设置窗口重新打开会读取新版，Shell 侧变化在正常重新登录后加载。安装器不结束用户会话。
Keep source, installed files, active Shell code, GitHub releases and EGO submissions distinct. The installer never logs the user out.

## 规则失效与源图变更的应急处理 / Recovering from a changed source icon

应用更新图标后，源图指纹（`source_sha256`）会变化，绑定在旧指纹上的手动规则与 reviewed override 不再生效。历史版本对此完全静默，插件会悄悄退回自动分类（典型表现：原本归一化的图标变回「尖角白方块」或不带底板）。

**症状**

- 某个应用图标突然与主题风格不一致（尖角、无底板、未缩放）。
- 维护页顶部出现「检测到 N 条图标规则已失效…」告警。
- `status.rules_health.warnings > 0`，或 `last-run.json` 的 `rule_warnings` 非空。

**诊断**

```sh
icon-normalizer --json  # 然后在 stdin 输入 status 请求
python3 -c "import json,pathlib;d=json.loads(pathlib.Path.home().joinpath('.local/state/icon-normalizer/last-run.json').read_text());print(json.dumps(d.get('rule_warnings'), ensure_ascii=False, indent=2))"
```

`rule_warnings` 里 `error` 的含义：

| error | 含义 | 处理 |
| --- | --- | --- |
| `RULE_STALE_SOURCE` | 手动规则的指纹与当前源图不符 | 重新设置该图标的类别（会写入新指纹） |
| `RULE_UNBOUND` | 源图不可读 | 检查应用是否已卸载或路径变更 |
| `RULE_INVALID` | 类别非法或 `class`/`classification` 冲突 | 修正规则字段 |
| `OVERRIDE_STALE_SOURCE` | reviewed override 的指纹失效 | 更新 `overrides.json`，或改用本机规则 |

**处理**

1. 在设置里重新选择该图标的类别（或调用 `rules.set`），新指纹会随规则一起保存。
2. 若应用把图案重导出到另一个尺寸目录，规则会按「唯一文件名回退」自动接续，`rule_matched_by = basename`；无需人工干预。
3. 若图标是「满幅直角底板」，可选用 `plate-rounded` 类别，保留图案同时把轮廓改为 squircle。
4. 自备图标时使用 `{"skip": true, "keep_desktop_override": true}`，插件只释放记录、不改写启动器。

**案例**：DeepSeek Harness（Chrome PWA）在 2026-10 更新图标，源图从「透明底白鲸鱼」变为「白底黑鲸鱼」，路径由 `hicolor/256x256/...` 迁到 `512x512/...`，旧 override 因指纹与路径双重失配而失效，图标退化为尖角白方块。最终以「透明底鲸鱼源图 + 不绑定指纹的 `glyph` 规则」修复。
