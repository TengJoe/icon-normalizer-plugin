"""Unified control entry: --json (one request on stdin) and --scheduled (worker).

Lock ordering rule: acquire sync.lock FIRST, then read config/rules, then build
the Engine. The whole initialization is covered by the error envelope.
"""
from __future__ import annotations

import argparse
import hashlib
import fcntl
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import protocol as P
from . import service_control
from .config_store import (
    ConfigStore,
    load_overrides,
    read_json_file,
    write_json_file,
)
from .core.engine import Engine, EngineConfig, policy_fingerprint
from .errors import EXIT_BUSY, EXIT_OK, EXIT_OTHER, ProtocolError, reject
from .gsettings import default_base_theme, load_interface_settings, finish_pending_theme
from .core.transaction import atomic_write, durable_unlink
from .desktop import application_roots
from .policy import Policy, PolicyDefaults
from .preview import hash_icon_name
from .version import BACKEND_VERSION
from .profiles import ProfilesStore
from . import theme_follow
from .xdg import RuntimePaths, from_environment

LOCK_TIMEOUT_UI = 0.0        # UI writes do not wait
LOCK_TIMEOUT_READ = 0.1      # read operations wait up to 100ms per PROTOCOL.md §4
LOCK_TIMEOUT_WORKER = 0.75   # scheduled worker short-waits, then skips


@dataclass
class OperationContext:
    paths: RuntimePaths
    store: ConfigStore
    policy: Policy
    revision: str
    scheduled: bool
    lock: Any = None


# ---------------------------------------------------------------- locking
def _busy_probe(paths: RuntimePaths) -> bool:
    """Non-blocking lock probe; releases immediately."""
    try:
        paths.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(paths.lock_path, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
        return False
    except (BlockingIOError, OSError):
        return True


def _acquire(paths: RuntimePaths, timeout: float) -> Any | None:
    inherited = os.environ.get("ICON_NORMALIZER_LOCK_FD")
    if inherited is not None:
        # Private installer hand-off. Validate the descriptor against this
        # exact lock inode; inherited open-file descriptions keep the parent
        # lock held through revert and subsequent code removal.
        fd = int(inherited)
        actual, expected = os.fstat(fd), paths.lock_path.stat()
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError("Inherited lock does not match sync.lock")
        lock = os.fdopen(os.dup(fd), "a")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock
    paths.lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = open(paths.lock_path, "a")
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock.close()
                return None
            time.sleep(0.05)


# ---------------------------------------------------------------- engine
def _defaults() -> PolicyDefaults:
    return PolicyDefaults(base_theme=default_base_theme(None))


def _env_path_list(name: str) -> list[str] | None:
    """Colon-separated environment override; a test/deployment seam for sandboxes."""
    value = os.environ.get(name)
    if not value:
        return None
    return [p for p in value.split(":") if p]


def _build_engine(store: ConfigStore, policy: Policy, paths: RuntimePaths,
                  previous_source_theme: str | None = None) -> Engine:
    """Caller holds the lock; assemble the engine with every dependency."""
    application_dirs = _env_path_list("ICON_NORMALIZER_APPLICATION_DIRS")
    icon_search_path = _env_path_list("ICON_NORMALIZER_ICON_SEARCH_PATH")
    config = EngineConfig(
        home=paths.home,
        theme_dir=paths.theme_dir,
        theme_name=paths.theme_name,
        state_dir=paths.state_dir,
        user_applications=paths.user_applications,
        desktop=os.environ.get("XDG_CURRENT_DESKTOP", "GNOME"),
        policy=policy,
        overrides=load_overrides(paths.libexec, paths.state_dir),
        user_rules=dict(store.load_rules().get("icons", {})),
        application_dirs=tuple(application_dirs) if application_dirs is not None else None,
        icon_search_path=tuple(icon_search_path) if icon_search_path is not None else None,
        settings=load_interface_settings(),
        previous_source_theme=previous_source_theme,
    )
    return Engine(config)


# ---------------------------------------------------------------- helpers
def _iso(payload: Any, unix_key: str) -> str | None:
    if not payload or not payload.get(unix_key):
        return None
    return datetime.fromtimestamp(payload[unix_key], tz=timezone.utc).isoformat()


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _store_for(paths: RuntimePaths, defaults: PolicyDefaults | None = None) -> ConfigStore:
    return ConfigStore(paths.state_dir, defaults or _defaults())


# ---------------------------------------------------------------- operations
def op_status(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    paths = from_environment()
    units = service_control.units_status()
    config_exists = paths.config_path.exists()
    manifest = read_json_file(paths.manifest_path)
    baseline = read_json_file(paths.baseline_path)
    last_run = read_json_file(paths.last_run_path)
    last_scan = read_json_file(paths.last_scan_path)
    last_error = read_json_file(paths.last_error_path)
    recovery_pending = any(p.exists() for p in (
        paths.pending_path, paths.settings_pending_path, paths.revert_pending_path))
    installed = bool(manifest or baseline)
    try:
        from .gsettings import current_icon_theme

        active_theme = current_icon_theme(load_interface_settings())
    except Exception:
        active_theme = None
    source_theme = (baseline or {}).get("icon_theme")

    policy = None
    revision = None
    if config_exists:
        try:
            store = _store_for(paths)
            try:
                policy = store.load_policy()
                revision = store.revision(policy)
            except ValueError as exc:
                reject("INVALID_CONFIG", str(exc))
        except Exception as exc:
            return {
                "installed": installed, "backend_version": BACKEND_VERSION, "revision": None,
                "automatic": units["automatic"],
                "units": {k: dict(v) for k, v in units.items() if k in ("timer", "path")},
                "busy": _busy_probe(paths), "recovery_pending": recovery_pending,
                "active_theme": active_theme, "source_theme": source_theme,
                "overlay_in_use": (active_theme == paths.theme_name) if active_theme else None,
                "last_apply_at": _iso(last_run, "checked_at_unix"),
                "last_scan_at": _iso(last_scan, "checked_at_unix"),
                "summary": None, "stale": True,
                "last_error": {"code": "INVALID_CONFIG", "message": str(exc)[:200]},
                "diagnostics": ["config.json unreadable: " + str(exc)[:160]],
            }
    busy = _busy_probe(paths)
    try:
        follows_theme: bool | None = theme_follow.enabled(paths.state_dir)
    except (ProtocolError, ValueError):
        follows_theme = None
    summary = None
    stale = True
    if last_run and last_run.get("summary") and manifest:
        summary = last_run["summary"]
        summary_policy = last_run.get("policy_sha256") or manifest.get("policy_sha256")
        stale = summary_policy is None or (
            policy is not None and summary_policy != policy_fingerprint(policy)
        )
    error = None if not last_error else {
        "code": last_error.get("code", "INTERNAL_ERROR"),
        "message": last_error.get("message", ""),
    }
    return {
        "installed": installed,
        "backend_version": BACKEND_VERSION,
        "revision": revision,
        "automatic": units["automatic"],
        "units": {k: dict(v) for k, v in units.items() if k in ("timer", "path")},
        "busy": busy,
        "recovery_pending": recovery_pending,
        "active_theme": active_theme,
        "source_theme": source_theme,
        "overlay_in_use": (active_theme == paths.theme_name) if active_theme else None,
        "last_apply_at": _iso(last_run, "checked_at_unix"),
        "last_scan_at": _iso(last_scan, "checked_at_unix"),
        "summary": summary,
        "stale": stale,
        "last_error": error,
        "theme_follow": follows_theme,
    }


def op_doctor(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    paths = from_environment()
    checks: dict[str, dict[str, Any]] = {}
    try:
        import PIL  # noqa: F401

        checks["pillow"] = {"ok": True}
    except Exception as exc:
        checks["pillow"] = {"ok": False, "detail": str(exc)[:120]}
    try:
        import numpy  # noqa: F401

        checks["numpy"] = {"ok": True}
    except Exception as exc:
        checks["numpy"] = {"ok": False, "detail": str(exc)[:120]}
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk  # noqa: F401

        checks["gtk3"] = {"ok": True}
    except Exception as exc:
        checks["gtk3"] = {"ok": False, "detail": str(exc)[:120]}
    from .theme import _cache_binary

    checks["gtk_update_icon_cache"] = {"ok": _cache_binary() is not None}
    units = service_control.units_status()
    checks["systemd_user"] = {"ok": units["available"], "automatic": units["automatic"]}
    checks["gnome_shell_extension_dir"] = {
        "ok": (paths.home / ".local/share/gnome-shell/extensions").is_dir()
    }
    missing = [k for k, v in checks.items() if not v["ok"]]
    return {
        "ok_all": not missing,
        "checks": checks,
        "missing": missing,
        "install_hint": (
            "sudo apt install gir1.2-gtk-3.0 python3-gi python3-pil python3-numpy "
            "gtk-update-icon-cache"
            if missing
            else None
        ),
    }


def _rows_to_groups(rows: list[dict[str, Any]], rules: dict[str, Any]) -> list[dict[str, Any]]:
    """Map engine rows to the wire 'groups' shape (icon_id keyed, UI-consumable)."""
    groups: list[dict[str, Any]] = []
    for row in rows:
        icon_name = str(row.get("icon_name"))
        icon_id = hash_icon_name(icon_name)
        rule = rules.get(icon_id)
        skipped = bool(rule and rule.get("skip"))
        cls = row.get("class")
        auto_class = row.get("auto_class") or cls
        stale = False
        if rule and not rule.get("skip") and rule.get("classification") not in (None, "auto"):
            if rule.get("source_sha256") != row.get("source_sha256"):
                stale = True
                cls = auto_class
        action, reason = row.get("action"), row.get("reason")
        if skipped:
            action, reason = "skipped", "user_skip"
        if not row.get("source_path"):
            if action != "excluded":
                action, reason = "unresolved", row.get("reason") or "source_unavailable"
        manual_user = bool(
            rule and not stale and rule.get("classification") not in (None, "auto")
        )
        origin = (
            "user"
            if manual_user
            else "reviewed" if row.get("classification_confidence") == "reviewed" else "automatic"
        )
        groups.append({
            "icon_id": icon_id,
            "icon_name": icon_name,
            "names": row.get("names", []),
            "desktop_ids": row.get("desktop_ids", []),
            "source_path": row.get("source_path"),
            "source_sha256": row.get("source_sha256"),
            "source_ratio": row.get("source_ratio"),
            "classification": cls,
            "classification_origin": origin,
            "classification_stale": stale,
            "action": action,
            "reason": reason,
            "skipped": skipped,
        })
    return groups


def op_scan(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    engine = _build_engine(ctx.store, ctx.policy, ctx.paths)
    result = engine.sync(apply=False)
    rules = ctx.store.load_rules().get("icons", {})
    groups = _rows_to_groups(result.get("apps", []), rules)
    payload = {
        "revision": ctx.revision,
        "checked_at_unix": time.time(),
        "checked_at": _now_iso(),
        "summary": result.get("summary"),
        "groups": groups,
    }
    write_json_file(ctx.paths.last_scan_path, payload)
    warnings = result.get("warnings") or []
    return {
        "revision": ctx.revision,
        "summary": result.get("summary"),
        "groups": groups,
        "checked_at": payload["checked_at"],
        "warnings": (
            [{"code": "UNRESOLVED", "message": "存在未解析图标",
              "details": {"count": len(warnings)}}]
            if warnings
            else []
        ),
    }


def op_preview(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    from .preview import preview as run_preview

    return run_preview(
        args,
        paths=ctx.paths,
        store=ctx.store,
        policy=ctx.policy,
        revision=ctx.revision,
    )


def op_configure(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    if args["expected_revision"] != ctx.revision:
        reject("REVISION_CONFLICT", "策略已被其他上下文修改；请刷新后重试",
               details={"current_revision": ctx.revision})
    try:
        updated = ctx.store.apply_patch(ctx.policy, args["patch"])
    except ValueError as exc:
        reject("INVALID_CONFIG", str(exc))
    changed = ctx.store.write_policy_if_changed(updated)
    return {
        "revision": ctx.store.revision(updated),
        "effective_policy": updated.to_dict(),
        "changed": changed,
    }


def op_rules_set(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    if args["expected_revision"] != ctx.revision:
        reject("REVISION_CONFLICT", "策略已被其他上下文修改；请刷新后重试",
               details={"current_revision": ctx.revision})
    store = ctx.store
    rules = store.load_rules()
    icons = rules["icons"]
    icon_id = args["icon_id"]
    rule = args["rule"]
    if rule.get("reset"):
        icons.pop(icon_id, None)
    else:
        entry: dict[str, Any] = {"skip": rule["skip"], "classification": rule["classification"]}
        if rule.get("source_sha256"):
            entry["source_sha256"] = rule["source_sha256"]
        icons[icon_id] = entry
    store.write_rules_if_changed(rules)
    return {"revision": store.revision(), "rule": icons.get(icon_id, {"reset": True})}


def op_apply(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    if args["expected_revision"] != ctx.revision:
        reject("REVISION_CONFLICT", "策略已被其他上下文修改；请刷新后重试",
               details={"current_revision": ctx.revision})
    result = _apply_current(ctx, activate=args["activate"])
    return {
        "revision": ctx.revision,
        "summary": result.get("summary"),
        "file_operations": result.get("file_operations"),
        "recovered_transaction": result.get("recovered_transaction", False),
        "applied": result.get("applied", True),
    }


def _apply_current(ctx: OperationContext, *, activate: bool,
                   automatic_follow: bool = False, sync_only: bool = False) -> dict[str, Any]:
    from .gsettings import current_icon_theme
    paths = ctx.paths
    selected = current_icon_theme(load_interface_settings())
    baseline = read_json_file(paths.baseline_path)
    reference = baseline.get("icon_theme") if isinstance(baseline, dict) else ctx.policy.base_theme
    transition = (isinstance(selected, str) and selected != paths.theme_name and
                  selected != reference and paths.manifest_path.exists() and
                  paths.baseline_path.exists() and theme_follow.enabled(paths.state_dir))
    if not transition:
        if sync_only:
            return {"changed": False, "revision": ctx.revision, "source_theme": ctx.policy.base_theme}
        engine = _build_engine(ctx.store, ctx.policy, paths)
        return engine.sync(apply=True, activate=activate)
    assert isinstance(selected, str)
    original = _build_engine(ctx.store, ctx.policy, paths)
    updated = theme_follow.transition_policy(ctx.policy, selected, original.resolver.search_paths())
    baseline_doc = theme_follow.baseline_document(paths.baseline_path, updated, selected)
    engine = _build_engine(ctx.store, updated, paths, previous_source_theme=ctx.policy.base_theme)
    changes = {
        paths.config_path: json.dumps(ctx.store.policy_document(updated), ensure_ascii=False, indent=2).encode(),
        paths.baseline_path: json.dumps(baseline_doc, ensure_ascii=False, indent=2).encode(),
    }
    result = engine.sync(apply=True, activate=activate or automatic_follow,
                         state_changes=changes, activate_if_theme=selected)
    ctx.policy = updated
    ctx.revision = ctx.store.revision(updated)
    return {**result, "changed": True, "revision": ctx.revision, "source_theme": selected}


def op_profiles_list(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None
    return ProfilesStore(ctx.paths.state_dir).catalog()


def op_profiles_save(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None
    return ProfilesStore(ctx.paths.state_dir).save(args)


def op_profiles_delete(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None
    return ProfilesStore(ctx.paths.state_dir).delete(args)


def op_theme_follow(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None
    theme_follow.set_enabled(ctx.paths.state_dir, args["enabled"])
    return {"enabled": args["enabled"]}


def op_theme_sync(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None
    if not theme_follow.enabled(ctx.paths.state_dir) or service_control.units_status()["automatic"] not in ("on", "partial"):
        return {"changed": False, "revision": ctx.revision, "source_theme": ctx.policy.base_theme}
    return _apply_current(ctx, activate=False, automatic_follow=True, sync_only=True)


def op_automation(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    result = service_control.set_enabled(args["enabled"])
    if not result["ok"]:
        reject("AUTOMATION_FAILED", "systemd 触发器操作失败，已尝试恢复操作前状态",
               details={"units": result["units"]})
    return {"enabled": args["enabled"], "units": result["units"]}


def op_revert(args: dict[str, Any], ctx: OperationContext | None) -> dict[str, Any]:
    assert ctx is not None  # write/read ops always run under the lock
    engine = _build_engine(ctx.store, ctx.policy, ctx.paths)
    before = service_control.units_status()
    if any(not isinstance(before[name].get(key), bool)
           for name in ("timer", "path") for key in ("enabled", "active")):
        reject("AUTOMATION_FAILED", "无法确认自动维护状态；还原尚未开始")
    paths = ctx.paths
    journal = {
        "stage": "revert_prepared", "units_before": before,
        "manifest_before_sha": _file_sha(paths.manifest_path),
        "manifest_after_sha": hashlib.sha256(engine.revert_manifest_bytes()).hexdigest(),
    }
    atomic_write(paths.revert_pending_path, json.dumps(journal).encode(), 0o600)
    automation = service_control.set_enabled(False)
    if not automation["ok"]:
        restored = service_control.restore_units(before)
        if restored["ok"]:
            durable_unlink(paths.revert_pending_path)
        reject("AUTOMATION_FAILED", "停止自动维护失败；未执行文件还原",
               details={"units": restored["units"], "restored": restored["ok"]})
    try:
        result = engine.revert()
    except Exception:
        if not paths.pending_path.exists() and not paths.settings_pending_path.exists():
            restored = service_control.restore_units(before)
            if restored["ok"]:
                durable_unlink(paths.revert_pending_path)
        raise
    durable_unlink(paths.revert_pending_path)
    return {
        "restored_theme": result.get("restored_theme"),
        "removed_managed_files": result.get("removed_managed_files", 0),
        "automation": automation["units"],
        "ok": result.get("ok", True),
    }


OPERATIONS = {
    "status": op_status,
    "doctor": op_doctor,
    "scan": op_scan,
    "preview": op_preview,
    "configure": op_configure,
    "rules.set": op_rules_set,
    "apply": op_apply,
    "automation.set": op_automation,
    "revert": op_revert,
    "profiles.list": op_profiles_list,
    "profiles.save": op_profiles_save,
    "profiles.delete": op_profiles_delete,
    "theme.follow": op_theme_follow,
    "theme.sync": op_theme_sync,
}

WRITE_OPS = {"configure", "rules.set", "apply", "automation.set", "revert", "theme.sync"}


# ---------------------------------------------------------------- recovery
def _finish_settings_commit(paths: RuntimePaths, data: dict[str, Any]) -> None:
    finish_pending_theme(load_interface_settings(), paths.settings_pending_path, paths.manifest_path)


def _file_sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _finish_revert_commit(paths: RuntimePaths) -> None:
    data = read_json_file(paths.revert_pending_path) or {}
    if data.get("stage") != "revert_prepared":
        raise RuntimeError("Unknown revert recovery journal stage")
    digest = _file_sha(paths.manifest_path)
    if digest == data.get("manifest_after_sha"):
        result = service_control.set_enabled(False)
    elif digest == data.get("manifest_before_sha"):
        result = service_control.restore_units(data["units_before"])
    else:
        raise RuntimeError("Manifest changed externally during revert recovery")
    if not result["ok"]:
        reject("AUTOMATION_FAILED", "还原恢复尚未完成；自动维护状态恢复失败",
               details={"units": result["units"]})
    durable_unlink(paths.revert_pending_path)


def _recover_transactions(ctx: OperationContext) -> None:
    paths = ctx.paths
    if paths.pending_path.exists():
        engine = _build_engine(ctx.store, ctx.policy, paths)
        engine.recover()
    settings_pending = paths.settings_pending_path
    if settings_pending.exists():
        data = read_json_file(settings_pending) or {}
        _finish_settings_commit(paths, data)
    if paths.revert_pending_path.exists():
        _finish_revert_commit(paths)
    if not any(p.exists() for p in (
            paths.pending_path, paths.settings_pending_path, paths.revert_pending_path)):
        paths.last_error_path.unlink(missing_ok=True)


def _record_error(paths: RuntimePaths, exc: ProtocolError) -> None:
    if exc.code in ("BUSY", "REVISION_CONFLICT", "INVALID_REQUEST", "INVALID_CONFIG", "NOT_FOUND") or \
            exc.operation in ("profiles.list", "profiles.save", "profiles.delete", "theme.follow"):
        # Expected contention belongs to this response, not persistent health.
        return
    try:
        paths.state_dir.mkdir(parents=True, exist_ok=True)
        write_json_file(
            paths.last_error_path,
            {"code": exc.code, "message": exc.message, "at_unix": time.time()},
        )
    except Exception:
        pass


# ---------------------------------------------------------------- dispatch
def _launcher_stamp(paths: RuntimePaths) -> tuple[tuple[str, int, int], ...]:
    roots = _env_path_list("ICON_NORMALIZER_APPLICATION_DIRS")
    directories = [Path(p) for p in roots] if roots is not None else application_roots(paths.home)
    entries: list[tuple[str, int, int]] = []
    for directory in directories:
        for path in directory.rglob("*.desktop"):
            try:
                info = path.stat()
                entries.append((str(path), info.st_mtime_ns, info.st_size))
            except FileNotFoundError:
                continue
    return tuple(sorted(entries))


def handle(raw: bytes, scheduled: bool, paths: RuntimePaths | None = None) -> int:
    effective_paths = paths or from_environment()
    rid: str | None = None
    op: str | None = None
    try:
        _payload, rid, op, args = P.parse_request(raw)
        args = P.validate(op, args)
    except ProtocolError as exc:
        exc.request_id, exc.operation = rid, op
        P.emit(P.response_err(exc))
        return exc.exit_code
    try:
        if op in ("status", "doctor"):
            try:
                result = OPERATIONS[op](args, None)
            except ProtocolError as exc:
                exc.request_id, exc.operation = rid, op
                P.emit(P.response_err(exc))
                _record_error(effective_paths, exc)
                return exc.exit_code
            P.emit(P.response_ok(rid, op, result))
            return EXIT_OK
        if scheduled:
            timeout = LOCK_TIMEOUT_WORKER
        elif op in ("scan", "preview", "profiles.list"):
            timeout = LOCK_TIMEOUT_READ
        else:
            timeout = LOCK_TIMEOUT_UI
        lock = _acquire(effective_paths, timeout)
        if lock is None:
            reject("BUSY", "后台正在处理图标，请稍后重试", retryable=True,
                   request_id=rid, operation=op)
        with lock:
            store = _store_for(effective_paths)
            try:
                policy = store.load_policy()
                revision = store.revision(policy)
            except ValueError as exc:
                reject("INVALID_CONFIG", str(exc))
            ctx = OperationContext(
                paths=effective_paths, store=store, policy=policy,
                revision=revision, scheduled=scheduled, lock=lock,
            )
            if op in ("scan", "preview"):
                # scan must never repair production files; only report.
                if (
                    effective_paths.pending_path.exists()
                    or effective_paths.settings_pending_path.exists()
                    or effective_paths.revert_pending_path.exists()
                ):
                    reject("RECOVERY_REQUIRED", "存在未完成正式事务；请执行 apply 恢复",
                           request_id=rid, operation=op)
            elif op in WRITE_OPS:
                _recover_transactions(ctx)
                # Migration recovery can roll config.json back as well as icons.
                ctx.policy = store.load_policy()
                ctx.revision = store.revision(ctx.policy)
            result = OPERATIONS[op](args, ctx)
        P.emit(P.response_ok(rid, op, result))
        return EXIT_OK
    except ProtocolError as exc:
        exc.request_id = exc.request_id or rid
        exc.operation = exc.operation or op
        P.emit(P.response_err(exc))
        _record_error(effective_paths, exc)
        return exc.exit_code
    except Exception as exc:  # envelope must survive any backend failure
        err = ProtocolError("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}",
                            request_id=rid, operation=op)
        P.emit(P.response_err(err))
        _record_error(effective_paths, err)
        return EXIT_OTHER


def _run_scheduled(paths: RuntimePaths) -> int:
    lock = _acquire(paths, LOCK_TIMEOUT_WORKER)
    if lock is None:
        # EXIT_BUSY is a normal skip, not a failure; make the reason visible in
        # the journal instead of leaving a bare non-zero exit.
        print("icon-normalizer: skipped, another instance holds sync.lock",
              file=sys.stderr)
        return EXIT_BUSY
    with lock:
        try:
            store = _store_for(paths)
            policy = store.load_policy()
            ctx = OperationContext(
                paths=paths, store=store, policy=policy,
                revision=store.revision(policy), scheduled=True,
            )
            _recover_transactions(ctx)
            ctx.policy = store.load_policy()
            ctx.revision = store.revision(ctx.policy)
            # A queued worker must not recreate files after a completed revert.
            if service_control.units_status()["automatic"] == "off":
                return EXIT_OK
            # A path event arriving while its oneshot is active can otherwise
            # be consumed without a new run. Recheck launchers after commit;
            # our own Icon= rewrite causes at most one extra no-op pass.
            for _attempt in range(3):
                before = _launcher_stamp(paths)
                _apply_current(ctx, activate=False, automatic_follow=True)
                from .gsettings import current_icon_theme
                current = current_icon_theme(load_interface_settings())
                baseline = read_json_file(paths.baseline_path) or {}
                changed_theme = (isinstance(current, str) and current != paths.theme_name and
                                 current != baseline.get("icon_theme") and theme_follow.enabled(paths.state_dir))
                if _launcher_stamp(paths) == before and not changed_theme:
                    break
            return EXIT_OK
        except ProtocolError as exc:
            _record_error(paths, exc)
            return exc.exit_code
        except Exception as exc:
            err = ProtocolError("INTERNAL_ERROR", f"{type(exc).__name__}: {exc}")
            _record_error(paths, err)
            return EXIT_OTHER


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="icon-normalizer",
                                 description="Icon Normalizer unified backend control")
    ap.add_argument("--json", action="store_true",
                    help="one JSON request on stdin, one JSON response on stdout")
    ap.add_argument("--scheduled", action="store_true",
                    help="systemd worker mode: apply with current policy, no stdin")
    args = ap.parse_args(argv)
    paths = from_environment()
    if args.scheduled:
        return _run_scheduled(paths)
    if not args.json:
        ap.error("use --json (stdin request) or --scheduled")
    raw = sys.stdin.buffer.read(P.MAX_STDIN + 1)
    return handle(raw, scheduled=False, paths=paths)
