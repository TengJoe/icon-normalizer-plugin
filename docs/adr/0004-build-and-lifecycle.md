# ADR 0004 — 打包、安装与生命周期运维

状态：已采纳　日期：2026-10-02

## 背景

v2 安装器已完成快照/原子换装，但卸载逻辑在 `install.py` 与 `uninstall.py` 双份漂移；
路径布局以常量散落两脚本；测试语法检查脚本硬编码绝对项目路径。

## 决策

1. `tools/layout.py` 为安装布局唯一事实源：libexec（`~/.local/libexec/icon-normalizer`：
   `icon_normalizer/` 包 + `control.py` shim + `overrides.json`）、扩展目录、systemd 单元目录、
   状态/主题/缓存目录；`install.py`/`uninstall.py`/`build.py` 全部经其取路径。
2. 安装管线保持：precheck → 快照（代码/单元/config + 触发器态）→ 停触发 → 等待 worker 空闲 →
   暂存 + `py_compile` 全量验证 → 目录级原子换装 → 写单元 → `daemon-reload` → 恢复触发器态 →
   status 探活。任何失败回滚快照。
3. 卸载（含 `--keep-backend`）单一实现于 `install.py` 模块，`uninstall.py` 为薄封装；
   卸载先执行后端 `revert` 保证主题/入口 100% 字节级还原，backups 目录保留。
4. systemd 单元名与占位符不变；`service` 保持 `Type=oneshot` + 严格沙箱
   （`ProtectSystem=strict`、`ProtectHome=read-only`、`ReadWritePaths` 仅四个用户目录）；
   `Wants=icon-index-guard.service` 为外部配套单元（修复用户级 hicolor 索引），缺失时 systemd 容忍。
   `path` 单元监听用户/系统/Flatpak 三个入口目录实现"新装应用秒级归一化"，
   `timer`（每分钟）兜底素材供应商热更新。
5. `tools/build.py`：`glib-compile-schemas --strict` 前置门禁 → 扩展 ZIP（zip 根即 metadata.json）
   + 完整发行 tarball + `DIST_MANIFEST.json`（双工件 SHA-256）；版本唯一取自 `metadata.json`。
6. 前端语法门改为以 `import.meta.url` 推导项目根（删除硬编码绝对路径），并新增纯逻辑 node 单测。

## 后果

- 已安装环境从 v2 升级：libexec 目录整体换装，状态/主题/清单格式兼容（ADR-0001/0002）。
- `pip` 不作为分发方式；运行依赖（Pillow/numpy/python3-gi/gtk-update-icon-cache）由 precheck 诊断并给出安装提示。
