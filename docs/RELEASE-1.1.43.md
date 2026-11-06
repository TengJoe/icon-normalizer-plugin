# Icon Normalizer v1.1.43

发布日期：2026-11-06。扩展 **1.1.43**、配套后台 **3.1.20**（本版为工具修正），支持范围为已测试的 **GNOME Shell 51**。

## 修复

- `tools/verify.sh --quick` 之前会跳过 Q9（指示器回归），但它并不需要显示服务。现在 Q9 始终运行。

| 模式 | 结果 |
| --- | --- |
| `bash tools/verify.sh` | 13/13 通过 |
| `bash tools/verify.sh --quick` | 11/11 通过（跳过 Q8/Q10） |
