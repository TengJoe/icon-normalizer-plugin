"""Persistent faults, serialized separately from sync.lock, with bounded history.

The top-level last-error fields remain readable by old installations. `active`
keeps maintenance and automation independent: fixing a switch cannot dismiss a
failed apply. Only a completed operation may resolve its own health category.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Iterator

from .config_store import read_json_file, write_json_file
from .core.transaction import durable_unlink
from .errors import ProtocolError

EVENT_LIMIT = 64
EXPECTED = {"BUSY", "REVISION_CONFLICT", "INVALID_REQUEST", "INVALID_CONFIG", "NOT_FOUND", "STALE_SOURCE"}


def _active(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    if isinstance(data.get("active"), dict):
        return dict(data["active"])
    if data.get("code"):
        # Legacy faults have no operation; retain conservatively as maintenance.
        return {"maintenance": {k: v for k, v in data.items() if k != "active"}}
    return {}


@contextmanager
def _lock(state: Path) -> Iterator[None]:
    state.mkdir(parents=True, exist_ok=True)
    fd = os.open(state / "health.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        deadline = time.monotonic() + 0.1
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("health.lock is busy")
                time.sleep(0.005)
        yield


def _save(state: Path, active: dict[str, Any]) -> None:
    if active:
        latest = active.get("maintenance") or active["automation"]
        write_json_file(state / "last-error.json", {**latest, "active": active})
    else:
        durable_unlink(state / "last-error.json")


def _event(state: Path, kind: str, record: dict[str, Any]) -> None:
    history = read_json_file(state / "health-events.json") or []
    if not isinstance(history, list):
        history = []
    # Keep history small; conflict details live only in the active receipt.
    event = {k: record[k] for k in ("code", "operation", "first_seen_unix", "last_seen_unix", "count") if k in record}
    history.append({"kind": kind, "at_unix": time.time(), **event})
    write_json_file(state / "health-events.json", history[-EVENT_LIMIT:])


def record_error(state: Path, exc: ProtocolError) -> None:
    persisted_config_failure = (exc.code == "INVALID_CONFIG" and
                                exc.details.get("reason") == "PERSISTED_CONFIG_INVALID")
    if ((exc.code in EXPECTED and not persisted_config_failure) or
            exc.operation in ("profiles.list", "profiles.save", "profiles.delete", "theme.follow")):
        return
    # Preview/diagnostic failures are local requests, except global missing deps.
    if exc.operation in ("preview", "status", "doctor") and exc.code != "DEPENDENCY_MISSING":
        return
    category = "automation" if exc.operation == "automation.set" else "maintenance"
    try:
        with _lock(state):
            active = _active(read_json_file(state / "last-error.json"))
            old = active.get(category, {})
            signature = hashlib.sha256(json.dumps({"code": exc.code, "message": exc.message,
                "details": exc.details}, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            same = old.get("signature") == signature or (
                "signature" not in old and old.get("code") == exc.code and old.get("message") == exc.message)
            now = time.time()
            record: dict[str, Any] = {"code": exc.code, "message": exc.message, "details": exc.details,
                      "operation": exc.operation or "scheduled", "at_unix": now,
                      "first_seen_unix": old.get("first_seen_unix", old.get("at_unix", now)) if same else now,
                      "last_seen_unix": now, "count": int(old.get("count", 1)) + 1 if same else 1,
                      "signature": signature}
            active[category] = record
            _save(state, active)
            if not same:
                _event(state, "changed" if old else "failed", record)
                print(f"icon-normalizer: {category} blocked: {exc.code}: {exc.message}", file=sys.stderr)
            elif record["count"] % 10 == 0:
                print(f"icon-normalizer: {exc.code} persists ({record['count']} failures)", file=sys.stderr)
    except (OSError, ValueError, TypeError) as failure:
        print(f"icon-normalizer: could not record health: {failure}", file=sys.stderr)


def resolve(state: Path, category: str = "maintenance") -> None:
    try:
        with _lock(state):
            active = _active(read_json_file(state / "last-error.json"))
            old = active.pop(category, None)
            if old is not None:
                _save(state, active)
                _event(state, "recovered", old)
                print(f"icon-normalizer: {category} recovered after {old.get('count', 1)} failures", file=sys.stderr)
    except (OSError, ValueError, TypeError) as failure:
        print(f"icon-normalizer: could not resolve health: {failure}", file=sys.stderr)


def status_error(state: Path) -> dict[str, Any] | None:
    path = state / "last-error.json"
    active = _active(read_json_file(path))
    record = active.get("maintenance") or active.get("automation")
    if not isinstance(record, dict) or not isinstance(record.get("code"), str) or not isinstance(record.get("message"), str):
        return {"code": "IO_ERROR", "message": "Health receipt is unreadable", "details": {"reason": "invalid_health_receipt"}} if path.exists() else None
    return {k: v for k, v in record.items() if k not in ("signature", "active")}
