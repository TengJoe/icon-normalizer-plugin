"""Transaction store tests: atomicity, journaling, recovery, ownership."""
from __future__ import annotations

import base64
import json
import os
import stat
from unittest.mock import patch
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.core.transaction import (  # noqa: E402
    ProtectedRoot,
    TransactionError,
    TransactionStore,
    atomic_write,
    safe_path,
    sha_hex,
)


class TestPrimitives(unittest.TestCase):
    def test_file_and_parent_directory_fsynced_after_replace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "file.txt"
            native = os.fsync; events = []
            def sync(fd):
                directory = stat.S_ISDIR(os.fstat(fd).st_mode)
                events.append((directory, path.exists()))
                native(fd)
            with patch('icon_normalizer.core.transaction.os.fsync', side_effect=sync):
                atomic_write(path, b'durable', 0o600)
            self.assertEqual(events, [(False, False), (True, True)])

    def test_journal_removal_is_directory_synced(self) -> None:
        from icon_normalizer.core.transaction import durable_unlink
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pending.json'; path.write_bytes(b'journal')
            native = os.fsync; events = []
            def sync(fd):
                events.append((stat.S_ISDIR(os.fstat(fd).st_mode), path.exists()))
                native(fd)
            with patch('icon_normalizer.core.transaction.os.fsync', side_effect=sync):
                durable_unlink(path)
            self.assertEqual(events, [(True, False)])

    def test_atomic_write_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "file.txt"
            atomic_write(path, b"hello", 0o644)
            self.assertEqual(path.read_bytes(), b"hello")

    def test_safe_path_refuses_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "real"
            target.mkdir()
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                safe_path(link / "file.txt")
            link2_parent = root / "real2"
            link2_parent.mkdir()
            nested_link = link2_parent / "sub"
            nested_link.symlink_to(target)
            with self.assertRaises(ValueError):
                safe_path(nested_link / "file.txt")
            atomic_write(target / "ok.txt", b"data")  # direct path is fine


class TestTransactionStore(unittest.TestCase):
    def _store(self, root: Path, finalize=None) -> TransactionStore:
        return TransactionStore(
            journal_path=root / "state" / "pending.json",
            roots=[
                ProtectedRoot(path=root / "theme", file_mode=0o644),
                ProtectedRoot(path=root / "state", file_mode=0o600),
            ],
            finalize=finalize,
        )

    def test_allowed_whitelist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = self._store(root)
            ok = store.allowed(root / "theme" / "a.png")
            self.assertEqual(ok, (root / "theme" / "a.png").absolute())
            with self.assertRaises(ValueError):
                store.allowed(Path("/etc/passwd"))

    def test_commit_writes_and_skips_noops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "theme").mkdir()
            calls = []
            store = TransactionStore(
                journal_path=root / "state" / "pending.json",
                roots=[ProtectedRoot(path=root / "theme", file_mode=0o644)],
                finalize=lambda c: calls.append(c),
            )
            target = root / "theme" / "a.png"
            atomic_write(target, b"same", 0o644)
            ops, changed = store.commit({target: b"same", root / "theme" / "new.png": b"data"})
            self.assertEqual(ops, 1)
            self.assertTrue(changed)
            self.assertEqual((root / "theme" / "new.png").read_bytes(), b"data")
            self.assertFalse(store.journal_path.exists())
            self.assertEqual(calls, [True])

    def test_journal_allows_recovery_after_interruption(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "theme").mkdir()
            store = self._store(root)
            target = root / "theme" / "a.png"
            atomic_write(target, b"before", 0o644)
            before_bytes = b"before"
            after_bytes = b"after"
            ops = [{
                "path": str(target),
                "before": base64.b64encode(before_bytes).decode(),
                "before_sha": sha_hex(before_bytes),
                "after_sha": sha_hex(after_bytes),
                "before_mode": 0o644,
            }]
            store.journal_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(store.journal_path, json.dumps({"ops": ops}).encode(), 0o600)
            # simulate an interrupted apply: the file was written, then crash
            atomic_write(target, after_bytes, 0o644)
            self.assertTrue(store.recover())
            self.assertEqual(target.read_bytes(), before_bytes)
            self.assertFalse(store.journal_path.exists())

    def test_recovery_aborts_on_external_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "theme").mkdir()
            store = self._store(root)
            target = root / "theme" / "a.png"
            ops = [{
                "path": str(target),
                "before": None,
                "before_sha": None,
                "after_sha": sha_hex(b"x"),
                "before_mode": 0o644,
            }]
            store.journal_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(store.journal_path, json.dumps({"ops": ops}).encode(), 0o600)
            atomic_write(target, b"user edits", 0o644)
            with self.assertRaises(TransactionError):
                store.recover()
            self.assertEqual(target.read_bytes(), b"user edits")

    def test_deletion_ops_and_finalize_on_recover(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            theme = root / "theme"
            theme.mkdir()
            (theme / "index.theme").write_text("index")
            finalized = []
            store = self._store(root, finalize=lambda c: finalized.append(c))
            target = theme / "a.png"
            atomic_write(target, b"data", 0o644)
            ops, _changed = store.commit({target: None})
            self.assertEqual(ops, 1)
            self.assertFalse(target.exists())
            self.assertEqual(finalized, [True])
            # journal-based deletion recovery: the undo replays the pre-image,
            # so a crashed deletion restores the original file.
            atomic_write(target, b"data", 0o644)
            ops2 = [{
                "path": str(target),
                "before": base64.b64encode(b"data").decode(),
                "before_sha": sha_hex(b"data"),
                "after_sha": None,
                "before_mode": 0o644,
            }]
            atomic_write(store.journal_path, json.dumps({"ops": ops2}).encode(), 0o600)
            self.assertTrue(store.recover())
            self.assertEqual(target.read_bytes(), b"data")

    def test_finalize_failure_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            theme = root / "theme"
            theme.mkdir()
            store = self._store(root)

            def boom(changed: bool) -> None:
                raise RuntimeError("cache failure")

            store.finalize = boom
            target = theme / "a.png"
            atomic_write(target, b"old", 0o644)
            with self.assertRaises(RuntimeError):
                store.commit({target: b"new"})
            self.assertEqual(target.read_bytes(), b"old")
            self.assertFalse(store.journal_path.exists())


if __name__ == "__main__":
    unittest.main()
