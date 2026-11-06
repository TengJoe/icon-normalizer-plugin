# Icon Normalizer v1.1.11

发布日期：2026-11-06。扩展 **1.1.11**、配套后台 **3.1.9**，支持范围为已测试的 **GNOME Shell 51**。API 版本仍为 1，**渲染核心版本升至 3**（预览缓存失效）。

## 新增

- **`plate-rounded` 类别**：适用于"满幅直角底板"的图标。渲染时保留图案与配色，仅把轮廓替换为 squircle 蒙版，使其与圆角图标网格一致。
- **`corner_alpha` 度量**：核心包围盒四角的不透明度，用于区分直角板与已圆角板。
- **`suggest_class()`**：为直角满幅板给出 `plate-rounded` 建议（仅建议，不自动应用）。

## 使用方式

对某个图标设置规则即可（示例）：

```json
{ "skip": false, "classification": "plate-rounded", "source_sha256": "<source sha>" }
```

## 兼容性

- 自动分类表未改变：`plate-rect` / `plate-circle` / `artwork` 的判定与渲染结果完全不变。
- `IconMetrics` 新增字段带默认值，旧缓存仍可读取。
- 分析缓存键纳入 `analyzer.py` 指纹，分析逻辑变化后自动重算。

## 验证

- 全量测试 **242 项通过**（新增 `test_plate_rounded.py` 5 项）。
