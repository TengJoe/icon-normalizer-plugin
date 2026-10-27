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

作者、许可证、项目与反馈入口保留；1.1.7 不包含捐赠元数据、Sponsor 配置、收款码或支付界面。
Author attribution, license, project and issue links remain. Version 1.1.7 contains no donation UI or payment assets.

本项目使用 AI 辅助生成和重构。维护者需要本人能够解释、调试和维护提交的 JavaScript；自动测试不能证明这项能力。公开提交前须审阅实际差异，并如实回应审核者。外部 Python 后台是否被 EGO 接受仍由审核者判断，代码整理和测试通过不表示审核批准。
AI assistance is used in this project. The submitter must personally understand, debug and maintain the code. Automated checks and this guide do not establish that ability or guarantee EGO approval.

Shell 缓存模块；安装新文件不表示当前会话已经重载。设置窗口重新打开会读取新版，Shell 侧变化在正常重新登录后加载。安装器不结束用户会话。
Keep source, installed files, active Shell code, GitHub releases and EGO submissions distinct. The installer never logs the user out.
