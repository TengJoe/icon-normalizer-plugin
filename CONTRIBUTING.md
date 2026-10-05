# 贡献指南 / Contributing

[简体中文](#简体中文) · [English](#english) · [文档索引 / Documentation](docs/README.md)

## 简体中文

欢迎通过 [Issues](https://github.com/TengJoe/icon-normalizer-plugin/issues) 报告问题、提出建议，或提交 Pull Request。较大的功能调整请先说明目标、使用场景与预期行为，方便确认实现边界。

### 报告问题

请提供 GNOME Shell 版本、发行版、扩展与后台版本、安装方式、复现步骤、预期结果和实际结果。界面问题请注明语言、窗口尺寸与主题；日志和截图请先去除用户名、个人路径、令牌及账户信息。

不要把运行时状态、备份或账户截图加入源码。微信与支付宝收款码是维护者明确授权的公开支持素材；新增或替换收款方式需先取得维护者确认。

### 修改代码

后台是配置、图标与服务状态的写入方；前端负责展示和请求编排。保持 GTK 3 后台与 GTK 4 设置窗口的进程隔离，遵守[协议规范](PROTOCOL.md)中的版本、错误码、锁序与事务规则。

修改后运行下方与变更相关的检查。发布前完成[验收清单](docs/CHECKLIST.md)，将隔离环境测试与真实桌面观察分别记录；未执行的项目不能标记为通过。

### 文档与写作规范

- **信息顺序**：先说明结果和用途，再列要求、操作步骤、验证方法与已知限制。首页面向使用者，实现细节放入技术文档。
- **语言一致**：中文使用中文标点，英文使用英文标点；品牌写作 `GNOME Shell`、`GJS`、`GTK 3`、`GTK 4`、`Libadwaita`、`GdkPixbuf`、`Pillow`、`NumPy` 和 `systemd`。正文统一使用“后台 / backend”“自定义方案 / custom profile”“素材主题 / source theme”。
- **界面与标识**：操作说明使用当前界面中的真实标签。路径、命令、JSON 字段和错误码使用行内代码，不翻译协议标识。
- **中英文同步**：修改安装、兼容性、功能、限制或支持说明时，同步更新两份 README。双语长文按语言分节，避免逐句交替；技术规范和 ADR 可以保留原语言，并在索引说明。
- **Markdown 格式**：每篇文档只有一个一级标题，标题不跳级。标题、列表、表格和代码块前后留空行；代码块注明语言，目录树使用 `text`。表格列数一致，行末不留多余空格，文件末尾保留一个换行。
- **命令与链接**：命令从仓库根目录执行，使用可移植的 `python3`、`node` 或项目工具。仓库内资料使用相对链接，外部链接使用描述性文字；变更后核对目标文件和标题锚点。
- **版本与证据**：扩展版本以 `extension/metadata.json` 为准，后台版本以 `backend/icon_normalizer/version.py` 为准。区分当前能力、历史决策和计划，避免“100% 覆盖”“保证审核通过”等未经验证的结论。
- **提交说明**：标题简要描述实际改动，正文说明影响与验证。文档维护不需要重打版本标签或覆盖已发布安装包；程序更新应按发布流程验证和打包。

## English

Report bugs and suggest improvements through [Issues](https://github.com/TengJoe/icon-normalizer-plugin/issues), or submit a pull request. For substantial feature changes, describe the goal, use case, and expected behavior first so the implementation scope can be agreed on.

### Reporting issues

Include your GNOME Shell version, distribution, extension and backend versions, installation method, reproduction steps, expected result, and actual result. For interface issues, include the language, window size, and theme. Remove usernames, personal paths, tokens, and account details from logs and screenshots.

Keep runtime state, backups, and account screenshots out of the source tree. The maintainer has explicitly authorized the existing WeChat Pay and Alipay codes for public support. Adding or replacing payment methods requires the maintainer's confirmation.

### Changing code

The backend writes configuration, icons, and service state; the frontend presents information and coordinates requests. Keep the GTK 3 backend and GTK 4 preferences in separate processes, and follow the [protocol](PROTOCOL.md) for versioning, error codes, lock order, and transactions.

Run the checks below that are relevant to your change. Before a release, complete the [release checklist](docs/CHECKLIST.md). Record isolated tests separately from observations in a real desktop session; leave untested items marked as such.

### Documentation and writing conventions

- **Order**: explain the outcome and purpose before requirements, steps, validation, and limits. Keep the homepage focused on users and place implementation details in reference documents.
- **Terminology**: use `GNOME Shell`, `GJS`, `GTK 3`, `GTK 4`, `Libadwaita`, `GdkPixbuf`, `Pillow`, `NumPy`, and `systemd`. Use “backend,” “custom profile,” and “source theme” consistently.
- **Interface and identifiers**: use current interface labels in instructions. Format paths, commands, JSON fields, and error codes as inline code; do not translate protocol identifiers.
- **Language parity**: update both READMEs when installation, compatibility, features, limits, or support changes. Use separate language sections for longer bilingual documents. Technical specifications and ADRs may retain their original language, noted in the index.
- **Markdown**: use one top-level heading per document without skipping heading levels. Separate headings, lists, tables, and code blocks with blank lines. Specify code-block languages and use `text` for directory trees. Keep table columns consistent, omit trailing whitespace, and end files with one newline.
- **Commands and links**: run commands from the repository root using portable `python3`, `node`, or project tools. Use relative links for repository files and descriptive external links. Check target files and heading anchors after editing.
- **Versions and evidence**: read the extension version from `extension/metadata.json` and the backend version from `backend/icon_normalizer/version.py`. Distinguish current behavior, historical decisions, and plans. Describe tested limits precisely.
- **Commits**: give the change a concise title and describe its impact and validation. Documentation maintenance does not require moving release tags or replacing published packages. Code releases follow the release validation and build process.

## 开发检查 / Development checks

在仓库根目录执行。`mypy` 和 `jsonschema` 是测试依赖；运行依赖见 [README](README.md)。

Run from the repository root. `mypy` and `jsonschema` are test dependencies; see [README.en.md](README.en.md) for runtime requirements.

### 后台与安装 / Backend and installation

```bash
python3 -m mypy
python3 -m unittest discover -s tests/backend -p 'test_*.py'
python3 -m unittest discover -s tests/installation -p 'test_*.py'
```

### 前端 / Frontend

```bash
node tests/frontend/syntax-check.mjs
node tests/frontend/stateModel.test.mjs
node tests/frontend/i18n.test.mjs
node --experimental-vm-modules tests/frontend/indicator.test.mjs
node --experimental-vm-modules tests/frontend/backendClient.test.mjs
```

### 桌面验收与构建 / Desktop acceptance and build

```bash
python3 tests/frontend/test_runtime.py
python3 tests/frontend/headless_shell.py
python3 tools/build.py
python3 tools/release_audit.py --archive dist/icon-normalizer@joeydeng.local.zip
```

运行时检查需要可用的图形栈，使用隔离的后端数据；具体环境要求与手动项目见[验收清单](docs/CHECKLIST.md)。仅修改文档时，核对格式、链接、命令及版本即可，无需重新安装插件。

Runtime checks require an available graphical stack and use isolated backend data. The [checklist](docs/CHECKLIST.md) describes environment requirements and manual checks. For documentation-only changes, check formatting, links, commands, and versions without reinstalling the extension.
