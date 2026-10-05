# 版本记录 / Changelog

v1.1.1 是首个公开 GitHub Release；此前版本为开发历史。下载、安装与验证范围见 [v1.1.1 发布说明](docs/RELEASE-1.1.1.md)。

## 未发布 / Unreleased

### 元数据与上架准备

- 打包不再包含 `schemas/gschemas.compiled`：GNOME 审核规则 EGO-P-006 要求 45+ 扩展不要附带编译好的 schema，
  商店会在上传时自行编译。`tools/build.py` 与 `tools/release_audit.py` 共用 `tools/layout.py` 的
  `PACKAGE_EXCLUDE`，归档一致性检查随之同步；`tools/install.py` 仍为本地安装重新编译 schema。
  手动安装 ZIP 的用户需执行一次 `glib-compile-schemas`（已写入中英文 README）。
- `donations.custom` 改为单个 URL 字符串：GNOME 公告说明该字段可接受字符串或最多三个字符串的数组，
  字符串写法与商店现有扩展一致，避免不同解析器对数组的兼容差异。
  已发布的 v1.1.1 标签与安装包保持原发布内容，含此修复的构建用于上架候选。

### 文档与仓库维护

- 统一中英文 README 的结构、安装要求、界面术语与支持范围。
- 增加双语贡献指南、写作规范和文档索引，修正架构与协议说明中的历史范围和示例。
- 首页增加微信、支付宝收款码折叠区；GitHub 支持按钮链接至公开支持页面。
- 此处记录发布后的文档维护；v1.1.1 标签与安装包保持原发布内容。

## 前端 1.1.1 — 作者署名与中英文支持入口（后端保持 3.1.0）

- 维护页增加「关于与支持」：作者 TengJoe、版本、项目主页、反馈和许可证。
- 微信与支付宝使用维护者授权的原始收款码；弹窗按窗口空间缩放并支持滚动。
- 新增中英文支持说明与 GNOME donations.custom 链接，支付操作在对应应用完成。
- Wise 银行账户详情不进入源码或发行包，待提供公开收款链接后再接入。
- 提交审计将 URL 检查改名为 source_url_format，明确它不验证仓库公开状态。

## 前端 1.1.0 / 后端 3.1.0 — 自定义方案、主题跟随与上架加固

- 规则页加入命名方案的保存、使用、重命名和删除；保存与使用均不自动修改生效配置。
  独立 OCC 版本防止多窗口覆盖，私有存储支持中英文名称并拒绝控制字符/同名。
- 新图标主题沿用视觉参数和逐图标规则，图标与配置/还原目标同事务迁移。
  激活守卫尊重用户后续选择；Shell 去抖监听加速、systemd timer 在窗口关闭时兜底。
- 修复停用后旧回包污染新会话、请求源未清理、构造失败监听泄漏、信号终止子进程
  错误读取退出码、缺失后端提示与合并参数校验；写操作始终允许后台完成。
- 原子写与事务删除同步父目录，补齐断电场景的目录项持久化。
- ZIP 单独升级遇到旧后台时明确提示安装完整发行包，主题监听跳过不支持的操作。
- GPLv3 许可证进入工程/扩展包；兼容声明收敛至实测 GNOME 51；新增提交前审计门。

## 前端 1.0.6 — 顶栏图标与完整中英文界面（后端保持 3.0.2）

- 顶栏文字改为主题着色的 symbolic SVG；菜单重排为状态摘要、主题/最近应用、
  带图标的检查/应用操作、自动维护与设置，运行摘要保持正常文字对比度。
- 全部应用界面文案接入共用中英文目录，覆盖三页、预览、通知、确认框、
  17 个后端协议错误码、顶栏与无障碍名称。默认跟随系统，维护页可选择简体中文/English。
- 即时语言切换只更新现有控件的文案，保留当前页面、搜索条件及未保存参数与
  revision；不替换正在动画中的页面，不翻译应用名称/主题名/用户数据；关闭时断开监听。
- 操作区与预览使用原生 FlowBox 自动计算换行高度，避免缩放/语言切换期间
  固定高度容器的旧尺寸与新布局冲突；窄窗口检查实际按钮位置与横向边界。
- 检查/自动维护操作后重新读取完整 status，避免把 scan 响应当成状态仪表盘；
  检查与应用进行时暂时禁用对应菜单操作。
- 新增完整英文使用说明；加入目录覆盖/占位符回归、中英文各 18 个布局场景、
  语言切换与草稿保护、真实 GNOME Shell 双语菜单截图及图标/路由/生命周期验收。

## 前端 1.0.5 — 设置界面统一与窗口自适应（后端保持 3.0.2）

- 三页统一原生卡片、8px 圆角操作按钮、紧凑胶囊状态标签和行内提示；
  GTK 样式独立放入 preferences.css，Shell 的 St 样式保持隔离。
- 内容上限扩展至 960px；窄窗口操作按钮纵向排列、筛选自动换行，
  原生导航自动移至底部。应用列表随窗口可用高度调整，预览双栏自动改为单栏。
- 从协议 v1 的只读 preview 获取已保存策略，修复新窗口参数回显默认值，
  列表目标占比也使用同一份策略；保存绑定读取时的 revision，拒绝覆盖外部修改。
- 新增真实 GTK 自适应回归：六种窗口尺寸 × 三页、深浅主题、预览宽窄布局、
  参数回显、仅打开零配置写入、保存重读和外部配置冲突。

## 前端 1.0.3 — 顶栏启动复查修复（后端保持 3.0.2）

- 修复 Indicator 缺少 menu getter 导致的 addMenuItem TypeError；构造失败时
  销毁已创建的按钮，正常销毁可重复调用。
- 新增六项真实入口/顶栏模块行为回归：完整菜单、开关信号、检查/设置路由、
  应用去重、销毁/重启和构造失败清理。
- 增加本机 St.Theme 真实样式解析门；原有正则样式检查只作快速提示。
- 提供独立 HOME、总线与假 systemd 的 GNOME Shell 51 headless 验收，
  验证真实 PanelMenu/PopupMenu、检查/应用、开关守卫和 disable/enable。

## 3.0.2 — 真实接管验收加固（前端 version-name 1.0.2）

- 自动 worker 在提交后复核启动器目录版本，处理服务运行期间到达的新安装/卸载事件，
  最多三轮；自身 Icon= 改写后的额外扫描为 no-op。
- BUSY 与 REVISION_CONFLICT 保持响应级错误，不写入持久健康故障。
- 补充事件期间目录变更与 BUSY 健康记录回归；后端全量 120 项。

## 3.0.1 — 发布前加固（前端 version-name 1.0.1）

- 修复设置模块四个相对导入；语法门同时验证依赖文件存在。真实 GNOME 51
  设置加载器、Gtk4 三页、五档预览和还原确认取消均加入回归。
- 修复 GJS 样式路径解析、Adw.Dialog 非法 modal 属性、ActionRow 详情赋值；
  预览程序性控件同步不重复发请求，晚到响应不覆盖新选择。
- 安装/卸载持 install.lock 与 sync.lock；卸载通过继承锁描述符执行后端 revert，
  严格校验退出码与响应身份。worker 等待失败或状态未知时拒绝换装。
- 快照包括扩展/schema、后台和机器规则；仅恢复本插件三个单元。升级精确保留
  每个 enabled/active 状态；--keep-backend 仅删除面板。旧机器规则幂等迁移。
- 主题恢复必须同步读回成功才清除日志；完全还原增加主题和自动维护恢复日志，
  文件回滚时补偿主题，自动维护停止失败时禁止文件还原。排队的自动任务尊重关闭状态。
- 测试共用私有 runtime、不可达会话总线、内存 GSettings 与可记录状态的假 systemd；
  故障回归覆盖卸载失败、换装回滚、状态组合、并发锁和中断恢复。
- 后端版本由 version.py 单一来源读取，发行 tarball 排除 Python 缓存。

## 3.0.0 — 全局架构重构（前端 version-name 1.0.0）

### 后端（backend/icon_normalizer 包，BACKEND_VERSION 3.0.0）

- **包化重构**：冻结三脚本链（`icon-normalize/icon-audit/icon-normalizer`）重构为
  `core/{engine,analyzer,renderer,transaction,resolver}` 现代模块；数学逐行保真
  （阈值/死区/测量校正循环/阴影钳制不变），`mypy --strict` 全绿。
- **并发扫描**：主线程持有全部 `Gtk.IconTheme` 查询（GTK3 非线程安全），
  工作线程池执行 GdkPixbuf 装载（线程安全）与 PIL/numpy 分析渲染；结果按键收集保持确定性。
- **协议 v1 冻结**：线格式/错误码/退出码逐字节不变；修复
  `_write_json_file` 忽略 mode（状态文件现 0600）、preview 超限改报 `IO_ERROR`、
  `MAX_STDIN` 海象遮蔽；`settings-pending.json` 主题激活二阶段日志转正（原为死代码）。
- **增量对比**：`input_key` 复用未变更渲染；失效源素材保留上一代产物；manifest 格式
  （version 1）不变，旧安装零迁移接管；`policy_sha256` 基准随包结构演进，
  升级后首轮 apply 全量重渲染一次属预期。
- **可移植化**：发行 overrides 仅保留可移植条目，机器专属条目迁移至
  `~/.local/state/icon-normalizer/overrides.json`（存在则合并）；默认主题回退 `hicolor`；
  `gtk-update-icon-cache` 经 PATH 探测；审计 CLI（含损坏的 HTML 画廊）退役，
  职责由 `scan`/`preview` 协议操作覆盖。
- **修复**：`_rows_to_groups` 的 `desktop_ids` 恒空与 `auto_class` 永不生效；
  no-op configure 现真正零写入（语义比较）；卸载/还原的冲突保护语义不变。

### 前端（GNOME 45–51 ESM，version-name 1.0.0）

- `Extension`/`ExtensionPreferences` 命名导入经真实 Shell 51 gresource 验证；
  `metadata.json` 声明 45–51。
- **应用图标页**：`Gtk.ListView + NoSelection + ListStore` 虚拟化列表、即时搜索、
  五态筛选胶囊（全部/需调整/保持/已跳过/补底板）并持久化到 GSettings。
- **对比预览**：`Adw.Dialog`（46+，45 回退 `Adw.Window`）；32–256px 多尺寸、
  深浅底切换、详细指标、跳过规则；`preview-size`/`preview-background` 接线生效。
- **规则页**：`Adw.SpinRow` 三参数 + 标准/紧凑/饱满预设；保存后以服务端
  `effective_policy` 回灌显示。
- **维护页**：卡片式仪表盘（版本/主题/托管数/自动维护/revision）、立即检查/应用/
  激活通道、还原前 `Adw.MessageDialog` 确认。
- **信号安全**：`bindSwitch` 守卫原语统一防 set_active 回环；面板 `PopupSwitchMenuItem`
  保留 GNOME 51 toggled 语义守卫；`applyFlow.js` 单一实现 status→apply→status 编排
  （面板与维护页共用），写操作超时永不击杀子进程。

### 工程化

- `tools/layout.py` 成为安装布局唯一事实源；卸载单一实现（`uninstall.py` 为薄封装）。
- `tools/build.py`：`glib-compile-schemas --strict` 硬门禁；ZIP + tarball +
  `DIST_MANIFEST.json`；版本唯一取自 `metadata.json`。
- 测试矩阵：后端 102 项（协议/OCC/事务自愈/生命周期 12 场景/预览/E2E）、
  前端 12 文件语法门 + 9 项纯逻辑单测、真实安装/卸载回归（临时 HOME）。

## 0.1.x（历史，详见旧版 CHANGELOG）

- 0.1.3 可选面板指示器（ADR-0002 旧）；0.1.2 apply 路由死锁修复；
  0.1.1 扩展入口五连修；0.1.0 首个可安装版本。
