"""Atomic writes with a crash-safe journal.

Every write the engine performs flows through :class:`TransactionStore`:

1. changed payloads are diffed against the disk, no-ops dropped;
2. ``pending.json`` (mode 0600) is durably written BEFORE the first changed file,
   capturing each victim's previous bytes and SHA-256;
3. files are applied atomically (temp + fsync + rename, symlink-safe);
4. the finalize hook (icon-cache rebuild) runs while the journal still exists;
5. the journal is removed only after the finalize hook succeeds.

An interrupted run is repaired by :meth:`TransactionStore.recover`, which replays
the journal in reverse after verifying that the disk still holds either the
before- or after-image of each file — external edits abort recovery instead of
being clobbered.
"""
from __future__ import annotations

import base64
import hashlib
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence


def sha_hex(data: bytes | None) -> str | None:
    return None if data is None else hashlib.sha256(data).hexdigest()


def safe_path(path: Path) -> Path:
    """Refuse to write through symlinks (target or any parent)."""
    path = Path(path).absolute()
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError(f"Refusing to write through symlink: {candidate}")
    return path


def atomic_write(path: Path, data: bytes, mode: int = 0o644) -> None:
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
        os.replace(tmp, path)
        _sync_directory(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_unlink(path: Path) -> None:
    path = safe_path(path)
    if path.exists():
        path.unlink()
        _sync_directory(path.parent)


@dataclass(frozen=True)
class ProtectedRoot:
    """A directory tree the engine may write, and the file mode to enforce."""

    path: Path
    file_mode: int


class TransactionError(RuntimeError):
    """Recovery or ownership verification failed; user review required."""


class TransactionStore:
    """Applies change-sets under the exclusive sync.lock held by the caller."""

    def __init__(
        self,
        journal_path: Path,
        roots: Sequence[ProtectedRoot],
        finalize: Callable[[bool], None] | None = None,
    ) -> None:
        self.journal_path = Path(journal_path)
        self.roots = [
            ProtectedRoot(path=Path(r.path).absolute(), file_mode=r.file_mode) for r in roots
        ]
        self.finalize = finalize

    # ---------- guards ----------
    def allowed(self, path: Path) -> Path:
        p = safe_path(path)
        for root in self.roots:
            if p == root.path or root.path in p.parents:
                return p
        raise ValueError(f"Unmanaged output path: {p}")

    def mode_for(self, path: Path) -> int:
        for root in self.roots:
            if path == root.path or root.path in path.parents:
                return root.file_mode
        return 0o644

    def under_root(self, path: Path, root: Path) -> bool:
        return path == root or root in path.parents

    # ---------- commit ----------
    def commit(
        self,
        changes: Mapping[Path, bytes | None],
        *,
        committed_last: tuple[Path, bytes] | None = None,
    ) -> tuple[int, bool]:
        """Apply a change-set; the manifest-like payload commits last.

        Returns ``(operations_applied, changed_under_first_root)``.
        """
        all_changes: dict[Path, bytes | None] = dict(changes)
        if committed_last is not None:
            all_changes[committed_last[0]] = committed_last[1]
        ops: list[dict[str, object]] = []
        payloads: list[bytes | None] = []
        theme_root = self.roots[0].path if self.roots else None
        for path, data in all_changes.items():
            p = self.allowed(path)
            before = p.read_bytes() if p.exists() else None
            if before == data:
                continue
            ops.append({
                "path": str(p),
                "before": base64.b64encode(before).decode() if before is not None else None,
                "before_sha": sha_hex(before),
                "after_sha": sha_hex(data),
                "before_mode": stat.S_IMODE(p.stat().st_mode) if p.exists() else 0o644,
            })
            payloads.append(data)
        changed_theme = False
        if ops:
            journal = {"ops": [{k: v for k, v in op.items()} for op in ops]}
            atomic_write(self.journal_path, _json_bytes(journal), 0o600)
        try:
            for op, data in zip(ops, payloads):
                p = Path(str(op["path"]))
                if data is None:
                    if p.exists():
                        durable_unlink(p)
                else:
                    atomic_write(p, data, self.mode_for(p))
                if theme_root is not None and self.under_root(p, theme_root):
                    changed_theme = True
            if self.finalize is not None:
                self.finalize(changed_theme)
            if ops:
                durable_unlink(self.journal_path)
        except Exception:
            self.recover()
            raise
        return len(ops), changed_theme

    # ---------- recovery ----------
    def recover(self) -> bool:
        """Replay the journal in reverse; True when a transaction was repaired."""
        if not self.journal_path.exists():
            return False
        import json

        txn = json.loads(self.journal_path.read_text())
        for op in reversed(txn["ops"]):
            p = self.allowed(Path(str(op["path"])))
            current = p.read_bytes() if p.exists() else None
            current_sha = sha_hex(current)
            if current_sha not in (op["after_sha"], op["before_sha"]):
                raise TransactionError(
                    f"External changes block transaction recovery: {p}"
                )
            before = op.get("before")
            if before is None:
                if p.exists():
                    durable_unlink(p)
            else:
                atomic_write(p, base64.b64decode(str(before)), int(op.get("before_mode", 0o644)))
        index = None
        if self.roots:
            index = self.roots[0].path / "index.theme"
        if self.finalize is not None and index is not None and index.is_file():
            self.finalize(True)
        durable_unlink(self.journal_path)
        return True


def _json_bytes(payload: object) -> bytes:
    import json

    return json.dumps(payload).encode()
