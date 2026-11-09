# Icon Normalizer v1.3.6

发布日期：2026-11-10。扩展 **1.3.6**、配套后台 **3.1.20**，支持范围为已测试的 **GNOME Shell 51**。

本版本处理三项工程债，用户可见行为只有一处（Python 后台不再能抢写主题）。

## 1. Python 后台降级为对照实现（oracle）

1.3.3 已把 systemd 触发器退役，但**代码层面**仍允许 Python 后台写同一套主题。两套渲染器在抗锯齿边缘的字节不同（每通道 ≤7/255），一旦交替写入，双方都会把对方的输出视为陌生而全量重渲（1.3.3 现场实测：每轮 634 个文件）。

现在加入**渲染所有权**：

| 角色 | 行为 |
| --- | --- |
| 扩展（进程内引擎） | 每次成功 apply 后写 `renderer.json`（`owner: "gjs"`） |
| Python `apply` / `revert` | 读到 `owner: "gjs"` 即拒绝，返回 `RENDERER_OWNED`（`retryable: false`，退出码 5） |
| Python `scan` / `status` / `preview` | 不受影响 —— 它们只读，修复流程仍需要 |
| 人工修复 / 跑对照 | `ICON_NORMALIZER_ALLOW_FOREIGN_RENDER=1` 显式放行 |

Python 仍是 `tools/parity.py` 的对照实现（它直接调用 `core.renderer`，不经过控制层），跨实现逐像素对拍照旧运行。

## 2. 隐私审计改为"全量扫描 + 显式例外"

旧实现只扫描一份**目录白名单**（`PUBLIC_DIRS`/`PUBLIC_FILES`），仓库里新出现的顶层文件或新子目录**永远不会被扫描**。现在：

- 扫描 `git ls-files` 的全部跟踪文件（本次 **250** 个）＋发行包成员，默认全扫；
- 唯一例外机制是 `tools/privacy-allowlist.txt`，每行必须写明 `路径<TAB>类别<TAB>理由`；
- 过期例外会在输出里列出来（`stale_allowlist_entries`），提示清理。

双向验证：新建顶层文件写入假 token → 检出；`tools/` 下新建子目录写入邮箱 → 检出；加入例外后通过。

## 3. 新增 Q21「release invariants」质量门

针对 1.3.2–1.3.5 反复出现的两类不一致：

1. **文档门数与脚本不符**：文档声称 20 道门而 `verify.sh` 实际定义 19 道。现在机械比对（`run Q<n>` 唯一标签计数），不符即失败。
2. **发布后改动随包代码却不升版本**：`v<当前版本>` 已存在时，`extension/` 与 `backend/` 不得再偏离该 tag；文档、测试、工具允许滞后。

双向验证：把 HANDOVER 的门数改成 19 → 报「advertises 19 gates, defines 21」；往 `extension/lib/variants.js` 追加一行 → 报「shipped code changed after v1.3.5」。

## 验证

- **21 道质量门**全部通过（`bash tools/verify.sh`）。
- 后端新增 6 项所有权测试；GJS 控制层新增 1 项 marker 测试。
