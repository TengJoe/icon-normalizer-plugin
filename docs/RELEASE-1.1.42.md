# Icon Normalizer v1.1.42

发布日期：2026-11-06。扩展 **1.1.42**、配套后台 **3.1.20**（本版为工具与文档变更），支持范围为已测试的 **GNOME Shell 51**。

## 新增

- `tools/verify.sh`：一条命令跑完 Q1–Q13 全部质量门。

```sh
bash tools/verify.sh          # 13 门全跑（需要显示服务）
bash tools/verify.sh --quick  # 跳过 Q8/Q10
```

实测结果：完整 **13/13 通过**，`--quick` **11/11 通过**。
