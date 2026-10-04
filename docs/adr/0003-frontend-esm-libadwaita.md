# ADR 0003 — 前端 GNOME 45~51 ESM / Libadwaita 重写

状态：已采纳　日期：2026-10-02

## 背景

v2 前端（`ui/preferences.js` 1020 行单文件）存在：三个 GSettings 死键、手写且重复的
信号防回环守卫、面板与维护页两份 apply 编排、Listbox 全量重渲染、`Adw.Dialog` 未使用、
死导入（GObject）与死常量（SIZES/_requestSeq）。

## 决策

1. 严格 GNOME 45+ ESM：`extension.js extends Extension`，`prefs.js extends ExtensionPreferences`
   并实现 `fillPreferencesWindow(window)`；`metadata.json` 声明 `45..51`。
2. 页面拆分为 `ui/{appsPage,rulesPage,maintenancePage,previewDialog}.js` + `lib/uiCommon.js`；
   纯文案映射继续收敛在 `lib/stateModel.js`（无副作用，可被 node 单测）。
3. 应用图标页改用 **Gtk.ListView + Gtk.NoSelection + Gio.ListStore**（GTK4 内建虚拟化，
   bind 回调惰性创建行），即时搜索重建 store；筛选为五态胶囊组
   （全部/需调整/保持/已跳过/补底板），并接线 GSettings `list-filter` 持久化。
4. 对比预览使用 **Adw.Dialog**（libadwaita ≥1.5 / GNOME 46），运行时特性检测，
   GNOME 45 回退 `Adw.Window.present()`；多尺寸（32..256）与深浅底即时切换，
   `preview-size` / `preview-background` 持久化。
5. 信号安全原语统一：`uiCommon.guardedSetActive()`（程序性 set_active 不触发
   notify::active 业务回调）与 `PopupSwitchMenuItem` 的 GNOME 51 toggled 语义守卫；
   杜绝 UI 属性刷新引起的后端写。
6. `lib/applyFlow.js` 承载 status→apply→status 编排（含 `activate = overlay_in_use===false`
   推导），面板与维护页共用；写操作超时永不击杀子进程（结果未确认语义）。
7. 后端唯一写者原则不变：前端不计算策略，只组装协议请求。

## 后果

- `GObject.registerClass` 仅用于 ListView 行数据对象；其余组件保持组合式构造。
- `stylesheet.css` 恢复职责（预览舞台卡/徽章样式入文件），删除运行时 CSS 注入的模块级单例。
