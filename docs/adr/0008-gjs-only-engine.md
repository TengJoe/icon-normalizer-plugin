# ADR-0008：纯 GJS 内嵌引擎与零外部依赖架构

状态：已实现。

## 背景

自 1.0 版本起，Icon Normalizer 采用扩展与外部 Python 后台分离的架构：
- 扩展（GJS）作为前端面板；
- 独立后台（Python + PyGObject + Pillow + NumPy）常驻运行，负责图标分析、渲染与主题生成。

这一设计在早期保护了 GNOME Shell 免受重型图像库崩溃的影响，但带来了显著代价：
1. **安装门槛高**：用户无法仅通过 extensions.gnome.org 一键安装，必须通过终端安装 Python 依赖与 systemd 服务；
2. **IPC 与进程开销**：每个操作都需要通过 subprocess 启动 Python 并通过 stdin/stdout 序列化传输 JSON；
3. **部署漂移风险**：扩展代码与后台代码可能发生版本脱节（如 Q14 曾发现的实测漂移）。

在 GNOME 51 环境下，GJS 支持 ES Modules，GdkPixbuf 原生提供快速的光栅化与合成能力，且现代 JavaScript 引擎（SpiderMonkey）具备充足的数值计算性能。

## 决策

### 1. 纯 GJS 引擎库 (`extension/lib/engine/`)

在扩展源码内实现自包含的图标处理引擎，仅依赖 GObject Introspection 核心库（`GdkPixbuf`、`GLib`、`Gio`），**零 GTK / St / Clutter 工具包依赖**：
- `analyze.js`：复刻半开包围盒、内缩环采样、椭圆 IoU 与四角不透明度分析；
- `render.js`：实现 Lanczos3 离散重采样、alpha 预乘与反预乘、超椭圆遮罩、可分离高斯阴影模糊；
- `desktop.js`：宽容 INI 解析、XDG 应用程序根目录遍历与保序字节级 `Icon=` 改写；
- `theme.js`：`index.theme` 生成、所有权标记检验与 `gtk-update-icon-cache` 声明周期；
- `transaction.js`：前置摘要守卫、原子替换与崩溃恢复日志；
- `resolver.js`：纯 JS XDG 图标解析器，按 freedesktop 规范遍历搜索路径与继承链；
- `classification.js`：规则优先级与状态机（active / stale_source / unbound / invalid）。

### 2. 重采样等价性保证

Cairo 原生仅提供 HYPER 与 BILINEAR 滤镜，与 Pillow 的 LANCZOS 存在肉眼可见差异。为此在 GJS 内实现独立的 Lanczos3 卷积核，并在滤波过程中实行 **alpha 预乘**（premultiplied alpha），避免半透明边界出现暗色伪影。
实测对比：16 个图标 × 9 档尺寸（144 组输出），与 Python 参考预言机相比占比偏差为 **0.00 px**，平均像素绝对差 ≤ 7.09/255（16 px 小尺寸限制在 ≤ 10.34/255）。

### 3. 进程内控制器 (`extension/lib/control.js`)

实现 `LocalControl` 调度器，暴露与原 Python `control.py` 严格兼容的操作信封（`status`、`scan`、`apply`、`preview`、`rules.set`、`configure`、`revert`、`doctor` 等）：
- 在 `extension.js` 与 `prefs.js` 启动时直接通过 `setLocalBackend` 挂载；
- 消除子进程调用、JSON 管道序列化与 systemd 服务依赖；
- 现有设置界面与顶栏逻辑零代码改动即可无缝运行。

### 4. 工具包隔离与宿主中立

引擎代码杜绝引入 `gi://Gtk`、`gi://Gdk`、`gi://Adw`、`gi://St`，满足 GNOME 扩展审核对 Shell 进程与 Prefs 进程的工具包隔离硬性要求。图标查找由纯 JS `XdgIconResolver` 负责，无需调用 `Gtk.IconTheme`。

### 5. 双轨验证与参考预言机

在过渡期间，Python 后端保留作为质量测试的参考预言机（`tools/parity.py`），全量单测通过 Q18（GJS 单元，61 项）与 Q19（GJS 等价性，144 组对比）进行持续把关。
