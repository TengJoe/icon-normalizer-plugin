# 发布验收 Checklist（前端 1.1.1 / 后端 3.1.0）

> 一键命令全部可在仓库根目录直接执行；标注 [手动] 的项目需要真实桌面会话。

## 1. 质量门（自动）

| # | 项目 | 命令 | 通过标准 |
|---|---|---|---|
| Q1 | 后端类型严格检查 | `~/.local/bin/mypy` | `Success: no issues found in 22 source files` |
| Q2 | 后端全量单测 | `python3 -m unittest discover -s tests/backend -p 'test_*.py'` | 147 tests OK |
| Q3 | 前端语法及相对导入 | `node tests/frontend/syntax-check.mjs` | 17 JS files ok，依赖存在 |
| Q4 | 前端纯逻辑单测 | `node tests/frontend/stateModel.test.mjs` | 11/11 passed |
| Q5 | 安装/卸载与故障回归 | `python3 -m unittest discover -s tests/installation -p 'test_*.py'` | 17 tests OK，独立假 manager |
| Q6 | 构建产物 | `python3 tools/build.py` | `glib-compile-schemas --strict` 无告警；dist/ 三件套生成 |
| Q7 | 协议契约一致性 | `contracts/*.schema.json` vs `PROTOCOL.md` | v1 原 9 操作兼容，新增 5 操作；17 错误码与退出码保持兼容 |
| Q8 | St 样式及 GJS/GTK4 设置与预览 | `python3 tests/frontend/test_runtime.py` | 9 tests OK；中英文各六种窗口尺寸 × 三页、预览、参数回显/保存/冲突、切换语言保留草稿、方案管理、旧后台升级提示与支持弹窗 |
| Q9 | 顶栏入口行为回归 | `node --experimental-vm-modules tests/frontend/indicator.test.mjs` | 12/12，图标、双语、状态/错误、路由、去重、销毁与重启、主题监听与旧后台守卫 |
| Q10 | 独立 GNOME Shell 51 验收 | `python3 tests/frontend/headless_shell.py` | ok=true；真实顶栏 API、检查/应用和生命周期 |
| Q11 | 中英文目录与错误码 | `node tests/frontend/i18n.test.mjs` | 5/5；全部 225 条翻译、占位符、自动检测、17 错误码与回切 |
| Q12 | 后端客户端与请求生命周期 | `node --experimental-vm-modules tests/frontend/backendClient.test.mjs` | 10/10；协议校验、缺失后台、信号退出、读取取消与写操作安全收尾 |

Q2/Q5 的 CLI 使用 tests/isolation.py：私有 runtime、不可达 session bus、
GSettings memory 后端、只记录 fixture 状态的 systemctl；临时 HOME 本身不提供会话隔离。
Q8 需要图形会话，但使用独立后端 fixture，不修改真实图标或自动维护。
需要保存当前系统的真实 GTK 渲染截图时，执行
`gjs -m tests/frontend/responsive-smoke.mjs "$PWD/extension" /tmp/icon-normalizer-ui readonly zh`。
将最后一个参数改为 `en` 可验证英文；只覆盖该测试窗口的语言读取，不写真实语言偏好。
该模式仅调用 status/scan/preview/profiles.list，保存与冲突测试只在 Q8 的隔离 fixture 中执行。
Q10 使用独立 headless Wayland Shell、HOME、keyfile GSettings、会话总线和假
systemctl，接受可选输出目录参数保存证据；不替换正在使用的桌面 Shell。
Q9 仅将 Shell/GI/后端边界换成测试替身，直接加载生产入口和顶栏模块；
真实 Shell API 兼容性由 Q10 验证。

## 2. 核心行为回归（Q2 覆盖的场景清单）

- [x] dry-run 零副作用；重复图标与 Hidden 覆盖处理正确
- [x] 首次 apply：命名+绝对路径图标、九档尺寸、缓存有效、死区回退、桌面 Action 字段原样
- [x] 重复 apply 幂等：零操作、字节与 mtime 不变、原文件仍是源
- [x] 源素材更新被检测；一次重建后稳定
- [x] 新装应用下一轮扫描即纳管
- [x] 卸载仅清理失效托管产物
- [x] 包更新暂时移除源素材时隔离（warning×2、保留上一代、其他应用继续可用）
- [x] 供应商系统启动器（绝对路径图标）的用户层覆盖随供应商更新/卸载
- [x] 回滚保留用户元数据编辑、字节级恢复 Icon= 与源素材
- [x] 缓存写入失败整体回滚事务、无 pending 残留
- [x] 中断的 apply 从磁盘日志恢复
- [x] 拒绝覆盖非托管文件（unowned collision）
- [x] 用户规则：skip 移除/恢复、SHA 绑定手工分类、素材变更后规则自动失效回退自动分类
- [x] REVISION_CONFLICT：错误信封携带 current_revision；no-op configure 零写入
- [x] pending 日志阻断 scan（RECOVERY_REQUIRED），apply 入口自愈
- [x] 超限请求/垃圾 stdin 返回结构化错误信封（exit 2）

## 3. 安装与生命周期 [手动 + Q5]

- [ ] `python3 tools/install.py` 在真实桌面通过（status 探活 ok=true）
- [ ] 升级路径：前端 1.0.6 / 后端 3.0.2 安装态被 1.1.1 / 3.1.0 接管（manifest 兼容），
      保留视觉参数、用户规则与自动维护状态；必要重建后 `status.stale == false`
- [ ] `systemctl --user status icon-normalizer.{timer,path}` 均 enabled+active；
      `touch ~/.local/share/applications/*.desktop` 后 ≤60s 内 `last-run.json` 更新
- [ ] 新装一个应用（或复制 .desktop 到 ~/.local/share/applications），
      path 触发在数秒内完成归一化
- [ ] 维护页“完全还原”确认对话框 → 桌面图标主题回到原主题、
      `~/.local/share/icons/DockNormalized` 无残留 PNG、
      被覆盖的 .desktop 与原始字节一致（`sha256sum` 对照）
- [ ] `python3 tools/uninstall.py` 后 libexec/扩展/单元全部移除，
      backups 目录保留；`--keep-backend` 仅移除面板

## 4. UI 体验 [手动，需 GNOME 51 会话]

- [ ] 偏好窗口打开：规则/应用图标/维护 三页渲染正常，样式表生效（徽章胶囊）
- [ ] 应用图标页数百图标平滑滚动（ListView 虚拟化）；搜索即时过滤；
      六态胶囊与 GSettings `list-filter` 持久化
- [ ] 点击行打开对比预览：32/48/64/128/256 切换、深浅底切换、
      `preview-size`/`preview-background` 持久化；跳过规则即时生效并刷新列表
- [ ] 规则页预设一键填入；保存并应用后 SpinRow 与服务端 effective_policy 一致
- [ ] 新开窗口读取实际已保存参数；中文最小 380×420、英文最小 420×420，
      至 1100×850 三页无横向溢出，
      窄窗口操作按钮纵排、筛选换行、列表随高度缩放；预览双栏切换为单栏
- [ ] 维护页仪表盘数字与 `status` 一致；自动维护开关程序性刷新不触发
      `automation.set`（信号守卫）；顶栏开关即时生效
- [ ] 顶栏指示器（开启后）：状态摘要、立即检查/应用、自动维护开关、设置入口；
      锁屏/解锁不残留 UI、不触碰后台
- [ ] 快速连点“立即应用”无死锁、无重复并发 apply（去重 + 单一流编排）
- [ ] 关于与支持显示作者 TengJoe、版本、许可证及项目链接；微信与支付宝收款码
      在中英文宽窄窗口下可扫描，关闭弹窗/父窗口后无残留。

## 5. 发布产物

- [ ] `dist/icon-normalizer@joeydeng.local.zip`（zip 根即 metadata.json）
- [ ] `dist/icon-normalizer-plugin-<version>.tar.gz`
- [ ] `dist/DIST_MANIFEST.json` 双 SHA-256 校验通过
- [ ] 升级快照位于 `~/.local/state/icon-normalizer/backups/install-snapshot-*`

## 6. 回滚预案

1. 设置窗口 → 维护 → 完全还原（推荐，含确认）。
2. `python3 tools/uninstall.py`（先 revert 再移除）。
3. 后台无法启动时，先恢复匹配版本的完整发行包，再使用“完全还原”或卸载器。
   保留状态文件与托管目录，恢复操作需要日志和原始字节；直接删除主题目录
   会让使用绝对图标路径的用户启动器失去图标，不能作为完整回滚步骤。
4. 升级失败自动回滚：快照 `install-snapshot-*` 经 `snapshot.json` 的 SHA-256
   校验后恢复 libexec/units/config 与触发器状态。


## Release 1.1.1 / backend 3.1 additional gates

```sh
python3 -m unittest discover -s tests/backend -v
python3 -m unittest discover -s tests/installation -v
python3 -m unittest discover -s tests/frontend -p 'test_runtime.py' -v
python3 -m mypy backend/icon_normalizer
node tests/frontend/syntax-check.mjs
node tests/frontend/stateModel.test.mjs
node tests/frontend/i18n.test.mjs
node --experimental-vm-modules tests/frontend/indicator.test.mjs
node --experimental-vm-modules tests/frontend/backendClient.test.mjs
python3 tools/build.py
python3 tools/release_audit.py --archive dist/icon-normalizer@joeydeng.local.zip
```

Submission additionally requires the actual public project URL and
`release_audit.py --submission`. See SUBMISSION.md for reviewer notes and final
manual checks. Testing dependencies include mypy and jsonschema; runtime
dependencies are listed in README.en.md.
