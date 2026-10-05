#!/usr/bin/env python3
"""User-level installer/upgrader/uninstaller (ADR-0004 §2/§3).

Pipeline: precheck → snapshot (code/units/config + trigger states) → stop
triggers → wait for the running worker → stage + compile-validate → atomic
swap → write units → install extension → daemon-reload → restore triggers →
status probe. Any failure restores code/units/config and trigger states from
the snapshot. All paths derive from the running user's HOME — never a
hardcoded user name.
"""
from __future__ import annotations

import argparse
import fcntl
from contextlib import contextmanager
import uuid
import tempfile
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from layout import EXTENSION_UUID, PROJECT_ROOT, TRIGGER_UNITS, UNITS, home, resolve, backend_version  # noqa: E402

BACKEND_VERSION = backend_version()


def log(message: str) -> None:
    print(message, file=sys.stderr)


def systemctl(args: list[str], timeout: int = 20) -> tuple[int | None, str, str]:
    try:
        proc = subprocess.run(
            ["systemctl", "--user", *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return None, "", str(exc)


def unit_states() -> dict[str, dict[str, bool | None]]:
    states: dict[str, dict[str, bool | None]] = {}
    for unit in TRIGGER_UNITS:
        rc, out, _err = systemctl([
            "show", unit, "--no-page", "--property=LoadState,UnitFileState,ActiveState",
        ])
        enabled = active = None
        if rc == 0:
            fields = dict(
                line.split("=", 1) for line in out.splitlines() if "=" in line
            )
            enabled = fields.get("UnitFileState") in (
                "enabled", "enabled-runtime", "generated", "transient",
            )
            active = fields.get("ActiveState") in ("active", "activating", "reloading")
            if fields.get("LoadState") == "not-found":
                enabled = active = False
        states[unit] = {"enabled": enabled, "active": active}
    return states


def precheck() -> list[str]:
    """Return the list of missing runtime dependencies."""
    missing: list[str] = []
    try:
        import PIL  # noqa: F401
    except Exception:
        missing.append("python3-pil")
    try:
        import numpy  # noqa: F401
    except Exception:
        missing.append("python3-numpy")
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk  # noqa: F401
    except Exception:
        missing.append("gir1.2-gtk-3.0 / python3-gi")
    if shutil.which("gtk-update-icon-cache") is None:
        missing.append("gtk-update-icon-cache")
    if shutil.which("systemctl") is None:
        missing.append("systemd")
    if shutil.which("glib-compile-schemas") is None:
        missing.append("glib-compile-schemas")
    if os.geteuid() == 0:
        missing.append("a non-root user")
    if home() == Path("/"):
        missing.append("a non-root HOME")
    if os.environ.get("XDG_DATA_HOME") and Path(os.environ["XDG_DATA_HOME"]) != (
        home() / ".local" / "share"
    ):
        missing.append("default XDG_DATA_HOME (non-default is unsupported in v1)")
    return missing


def _safe(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink():
            raise RuntimeError(f"Refusing managed symlink: {item}")


def _components(layout: Any) -> dict[str, Path]:
    return {"libexec": layout.libexec, "extension": layout.extension,
            **{f"units/{u}": layout.units / u for u in UNITS},
            **{n: layout.state / n for n in ("config.json", "user-rules.json", "overrides.json",
                                           "profiles.json", "theme-follow.json")}}


def _write_json(path: Path, value: Any) -> None:
    _safe(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".install-")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


@contextmanager
def locked(path: Path, timeout: float = 0.0):
    _safe(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Operation busy: {path.name}")
                time.sleep(0.05)
        yield fd
    finally:
        os.close(fd)


def checked_systemctl(args: list[str]) -> None:
    rc, out, err = systemctl(args)
    if rc != 0:
        raise RuntimeError(f"systemctl {' '.join(args)} failed: {(err or out)[:300]}")


def _known(states: dict[str, Any]) -> None:
    if any(not isinstance(states.get(u, {}).get(k), bool)
           for u in TRIGGER_UNITS for k in ("enabled", "active")):
        raise RuntimeError("Cannot confirm trigger state; no installation changes made")


def snapshot(target: Path, layout: Any, trigger_states: Any = None) -> Path:
    target.mkdir(parents=True, mode=0o700)
    files, existed = {}, {}
    for name, src in _components(layout).items():
        _safe(src)
        existed[name] = src.exists()
        if not src.exists():
            continue
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dest)
            for item in dest.rglob("*"):
                if item.is_file():
                    files[str(item.relative_to(target))] = _sha(item)
        else:
            shutil.copy2(src, dest)
            files[name] = _sha(dest)
    _write_json(target / "snapshot.json", {"version": 2, "created_at_unix": time.time(),
                "backend_version": BACKEND_VERSION, "sha256": files, "existed": existed,
                "trigger_states_before": trigger_states})
    return target


def _sha(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


#: Installation snapshots kept after a successful run. A snapshot exists to roll
#: back the run that created it, so older copies are dead weight in the state
#: directory; failures keep their snapshot and uninstall snapshots stay until
#: the user removes them.
SNAPSHOT_KEEP = 5


def prune_install_snapshots(layout: Any, keep: int = SNAPSHOT_KEEP) -> list[str]:
    """Remove the oldest installation snapshots; return the names removed."""
    roots = sorted((p for p in layout.backups.glob("install-snapshot-*") if p.is_dir()),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    for stale in roots[keep:]:
        shutil.rmtree(stale, ignore_errors=True)
        removed.append(stale.name)
    return removed


def restore_snapshot(snap_dir: Path, layout: Any) -> None:
    manifest = json.loads((snap_dir / "snapshot.json").read_text())
    for rel, digest in manifest["sha256"].items():
        if _sha(snap_dir / rel) != digest:
            raise RuntimeError(f"snapshot integrity failure: {rel}")
    for name, dest in _components(layout).items():
        if name not in manifest["existed"]:
            continue  # Older snapshots do not own newer user preference files.
        _safe(dest)
        if dest.is_dir():
            shutil.rmtree(dest)
        else:
            dest.unlink(missing_ok=True)
        if manifest["existed"][name]:
            src = snap_dir / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)
    log("complete installation snapshot restored")


def migrate_overrides(layout: Any) -> None:
    shipped = json.loads((PROJECT_ROOT / "backend" / "overrides.json").read_text())["icons"]
    candidates = [layout.libexec / "core" / "overrides.json", layout.libexec / "overrides.json"]
    config = layout.state / "config.json"
    if config.exists():
        configured = json.loads(config.read_text()).get("overrides")
        if configured:
            candidates.append(Path(configured))
    migrated = {}
    for path in candidates:
        if not path.is_file():
            continue
        data = json.loads(path.read_text())
        if not isinstance(data.get("icons"), dict):
            raise RuntimeError(f"Invalid legacy overrides: {path}")
        for name, value in data["icons"].items():
            current = shipped.get(name, {})
            if Path(name).is_absolute() or any(value.get(k) != current.get(k)
                                               for k in ("class", "source_sha256")):
                migrated[name] = value
    target = layout.state / "overrides.json"
    old = json.loads(target.read_text()) if target.exists() else {"schema_version": 1, "icons": {}}
    if old.get("schema_version") != 1 or not isinstance(old.get("icons"), dict):
        raise RuntimeError("Invalid user overrides")
    migrated.update(old["icons"])
    if migrated != old["icons"]:
        _write_json(target, {**old, "icons": migrated})


def stage_and_validate(staging: Path) -> None:
    """Copy the backend into staging and byte-compile every module.

    Nothing outside staging is touched until every file compiles.
    """
    staging.mkdir(parents=True)
    shutil.copy2(PROJECT_ROOT / "backend" / "control.py", staging / "control.py")
    shutil.copy2(PROJECT_ROOT / "backend" / "overrides.json", staging / "overrides.json")
    shutil.copytree(
        PROJECT_ROOT / "backend" / "icon_normalizer", staging / "icon_normalizer",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    for py in sorted(staging.rglob("*.py")):
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(py)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"staged module failed to compile: {py}\n{result.stderr}")


def install_units(layout: Any) -> None:
    layout.units.mkdir(parents=True, exist_ok=True)
    control_path = str(layout.control_path)
    for unit in UNITS:
        _safe(layout.units / unit)
        text = (PROJECT_ROOT / "packaging" / "systemd" / unit).read_text()
        rendered = text.replace("@HOME@", str(home())).replace("@CONTROL@", control_path)
        (layout.units / unit).write_text(rendered)


def install_extension(layout: Any) -> None:
    _safe(layout.extension)
    staging = layout.extension.parent / (".icon-normalizer-ext-" + uuid.uuid4().hex)
    layout.extension.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(PROJECT_ROOT / "extension", staging,
                        ignore=shutil.ignore_patterns("__pycache__", "*.js.map", "build"))
        binary = shutil.which("glib-compile-schemas")
        if not binary:
            raise RuntimeError("glib-compile-schemas unavailable")
        proc = subprocess.run([binary, "--strict", str(staging / "schemas")],
                              capture_output=True, text=True, check=False)
        if proc.returncode:
            raise RuntimeError("Schema compile failed: " + proc.stderr)
        if layout.extension.exists():
            shutil.rmtree(layout.extension)
        os.replace(staging, layout.extension)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def wait_service_idle(timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rc, out, _ = systemctl(
            ["show", "icon-normalizer.service", "--no-page", "--property=ActiveState"], timeout=8
        )
        if rc != 0:
            return False
        if "ActiveState=inactive" in out or "ActiveState=failed" in out:
            return True
        time.sleep(0.5)
    return False


def status_probe(layout: Any) -> tuple[bool, str]:
    """One-shot protocol status check against the freshly installed backend."""
    request = json.dumps({
        "api_version": 1, "request_id": "installer",
        "operation": "status", "arguments": {},
    })
    try:
        proc = subprocess.run(
            [sys.executable, str(layout.control_path), "--json"],
            input=request.encode(), capture_output=True, timeout=30, check=False,
        )
    except Exception as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, f"exit {proc.returncode}: {proc.stderr.decode()[:200]}"
    try:
        envelope = json.loads(proc.stdout.decode())
    except Exception:
        return False, "status probe produced no JSON envelope"
    valid = envelope.get("ok") is True and all(
        envelope.get(k) == v for k, v in {
            "api_version": 1, "request_id": "installer", "operation": "status"}.items())
    valid = valid and envelope.get("result", {}).get("backend_version") == BACKEND_VERSION
    return valid, "identity/version mismatch" if not valid else ""


def trigger_states_restore(before: dict[str, dict[str, bool | None]]) -> None:
    _known(before)
    current = unit_states()
    _known(current)
    for unit, state in before.items():
        if current[unit]["enabled"] != state["enabled"]:
            checked_systemctl(["enable" if state["enabled"] else "disable", unit])
        if current[unit]["active"] != state["active"]:
            checked_systemctl(["start" if state["active"] else "stop", unit])
    if unit_states() != before:
        raise RuntimeError("Trigger state read-back differs from requested state")


def _pending(layout: Any) -> bool:
    return any((layout.state / name).exists() for name in
               ("pending.json", "settings-pending.json", "revert-pending.json"))


def prepare_runtime(layout: Any) -> bool:
    """Create systemd's writable mounts without adopting an unowned theme."""
    for path in (layout.theme, layout.user_apps, layout.state, layout.preview_cache.parent):
        _safe(path)
    created = not layout.theme.exists()
    marker = layout.theme / ".icon-normalizer-owned"
    if not created and (not marker.is_file() or marker.read_text() != "icon-normalizer-owned-v1\n"):
        raise RuntimeError("Existing DockNormalized theme is not owned; installation aborted")
    for path in (layout.user_apps, layout.state, layout.preview_cache.parent):
        path.mkdir(parents=True, exist_ok=True)
    if created:
        layout.theme.mkdir(parents=True)
        marker.write_text("icon-normalizer-owned-v1\n")
    return created


def _failure(exc: Exception, compensation: Exception | None = None) -> int:
    log(str(exc))
    print(json.dumps({"ok": False, "stage": "failed", "error": str(exc),
                      "recovery_error": str(compensation) if compensation else None}))
    return 5


def install(assume_yes: bool) -> int:
    layout = resolve()
    missing = precheck()
    if missing:
        print(json.dumps({"ok": False, "stage": "precheck", "missing": missing}))
        return 4
    before, snap = None, None
    identifier = uuid.uuid4().hex
    staging = layout.libexec.parent / (".icon-normalizer-staging-" + identifier)
    old_dir = layout.libexec.parent / (".icon-normalizer-old-" + identifier)
    is_upgrade = layout.libexec.exists()
    clean_old = False
    created_theme = False
    try:
        with locked(layout.state / "install.lock"):
            before = unit_states()
            _known(before)
            try:
                if is_upgrade:
                    checked_systemctl(["disable", "--now", *TRIGGER_UNITS])
                    if not wait_service_idle():
                        raise RuntimeError("Worker did not become idle; upgrade aborted")
                with locked(layout.state / "sync.lock", timeout=30):
                    try:
                        if _pending(layout):
                            raise RuntimeError("Recovery pending; repair with the installed backend first")
                        snap = snapshot(layout.backups / ("install-snapshot-" + identifier), layout, before)
                        migrate_overrides(layout)
                        stage_and_validate(staging)
                        if layout.libexec.exists():
                            os.replace(layout.libexec, old_dir)
                        os.replace(staging, layout.libexec)
                        install_extension(layout)
                        install_units(layout)
                        checked_systemctl(["daemon-reload"])
                        ok, detail = status_probe(layout)
                        if not ok:
                            raise RuntimeError("Post-install status probe failed: " + detail)
                        created_theme = prepare_runtime(layout)
                        desired = before if is_upgrade else {
                            u: {"enabled": True, "active": True} for u in TRIGGER_UNITS}
                        trigger_states_restore(desired)
                        clean_old = True
                    except Exception:
                        if created_theme:
                            marker = layout.theme / ".icon-normalizer-owned"
                            if list(layout.theme.iterdir()) == [marker]:
                                marker.unlink()
                                layout.theme.rmdir()
                        if snap is not None:
                            restore_snapshot(snap, layout)
                            clean_old = True
                            checked_systemctl(["daemon-reload"])
                        raise
            except Exception as exc:
                try:
                    trigger_states_restore(before)
                except Exception as recovery:
                    return _failure(exc, recovery)
                return _failure(exc)
        pruned = prune_install_snapshots(layout)
        print(json.dumps({"ok": True, "stage": "done", "upgraded": is_upgrade,
                          "backend_version": BACKEND_VERSION, "snapshot": str(snap),
                          "snapshots_pruned": pruned,
                          "trigger_states_before": before, "extension": str(layout.extension)}))
        return 0
    except Exception as exc:
        return _failure(exc)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        if clean_old:
            shutil.rmtree(old_dir, ignore_errors=True)


def _revert_confirmed(layout: Any, lock_fd: int) -> None:
    request = {"api_version": 1, "request_id": "uninstall",
               "operation": "revert", "arguments": {}}
    env = dict(os.environ, ICON_NORMALIZER_LOCK_FD=str(lock_fd),
               ICON_NORMALIZER_STATE=str(layout.state), ICON_NORMALIZER_THEME=str(layout.theme),
               ICON_NORMALIZER_USER_APPS=str(layout.user_apps))
    proc = subprocess.run([sys.executable, str(layout.control_path), "--json"],
                          input=json.dumps(request).encode(), capture_output=True,
                          timeout=140, check=False, env=env, pass_fds=(lock_fd,))
    try:
        reply = json.loads(proc.stdout.decode())
    except Exception as exc:
        raise RuntimeError("Revert returned an invalid envelope; installation retained") from exc
    if proc.returncode != 0 or reply.get("ok") is not True or any(
            reply.get(k) != request[k] for k in ("api_version", "request_id", "operation")):
        raise RuntimeError("Revert failed; installation retained: " + str(reply.get("error")))


def uninstall(keep_backend: bool) -> int:
    layout = resolve()
    before = None
    try:
        with locked(layout.state / "install.lock"):
            if keep_backend:
                if layout.extension.exists():
                    backup = layout.backups / ("extension-only-" + uuid.uuid4().hex)
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(layout.extension, backup)
                    _safe(layout.extension)
                    shutil.rmtree(layout.extension)
                print(json.dumps({"ok": True, "keep_backend": True}))
                return 0
            before = unit_states()
            _known(before)
            try:
                checked_systemctl(["disable", "--now", *TRIGGER_UNITS])
                if not wait_service_idle():
                    raise RuntimeError("Worker did not become idle; uninstall aborted")
                with locked(layout.state / "sync.lock", timeout=30) as fd:
                    if layout.control_path.exists():
                        _revert_confirmed(layout, fd)
                    elif (layout.state / "manifest.json").exists() or (layout.state / "baseline.json").exists():
                        raise RuntimeError("Managed state exists but the recovery backend is missing")
                    snap = snapshot(layout.backups / ("uninstall-snapshot-" + uuid.uuid4().hex), layout, before)
                    try:
                        for path in (layout.libexec, layout.extension):
                            _safe(path)
                            if path.exists():
                                shutil.rmtree(path)
                        for unit in UNITS:
                            _safe(layout.units / unit)
                            (layout.units / unit).unlink(missing_ok=True)
                        checked_systemctl(["daemon-reload"])
                    except Exception:
                        restore_snapshot(snap, layout)
                        checked_systemctl(["daemon-reload"])
                        raise
            except Exception as exc:
                try:
                    if not _pending(layout):
                        trigger_states_restore(before)
                    else:
                        raise RuntimeError("Recovery journals retained; triggers remain stopped")
                except Exception as recovery:
                    return _failure(exc, recovery)
                return _failure(exc)
        print(json.dumps({"ok": True, "keep_backend": False, "backups_kept": str(layout.backups)}))
        return 0
    except Exception as exc:
        return _failure(exc)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--keep-backend", action="store_true",
                        help="remove only the extension panel")
    parser.add_argument("--assume-yes", action="store_true")
    args = parser.parse_args()
    if args.uninstall:
        return uninstall(args.keep_backend)
    return install(args.assume_yes)


if __name__ == "__main__":
    sys.exit(main())
