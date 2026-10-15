"""Bounded, deterministic conflict receipts; no force-overwrite path."""
from __future__ import annotations

from pathlib import Path
from typing import Any, NoReturn

from .errors import ProtocolError
from .policy import sha_hex


def conflict(path: Path, expected: str | None, *, icon: str | None = None,
             reason: str = "externally_modified") -> dict[str, Any]:
    return {"path": str(path), "expected_sha256": expected,
            "actual_sha256": sha_hex(path.read_bytes()) if path.is_file() else None,
            "icon_name": icon, "reason": reason}


def reject_conflicts(conflicts: list[dict[str, Any]]) -> NoReturn:
    unique = {row["path"]: row for row in conflicts}
    ordered = [unique[p] for p in sorted(unique)]
    raise ProtocolError("OWNERSHIP_CONFLICT", "检测到外部修改或非托管文件冲突，已停止本轮写入",
                        details={"conflict_count": len(ordered), "conflicts": ordered[:100],
                                 "truncated": len(ordered) > 100})
