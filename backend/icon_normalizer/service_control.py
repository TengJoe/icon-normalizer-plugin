"""systemd adapter: query/enable/disable the timer+path triggers.

Never kills a running oneshot worker; ``disable --now`` only stops the
triggers. A partial enable/disable is rolled back to the pre-operation state.
"""
from __future__ import annotations

import subprocess
import time
from typing import Any

UNITS = ("icon-normalizer.timer", "icon-normalizer.path")
SERVICE_UNIT = "icon-normalizer.service"


def _systemctl(args: list[str], timeout: float = 8.0) -> tuple[int | None, str, str]:
    try:
        proc = subprocess.run(
            ["systemctl", "--user", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return None, "", str(exc)


def _show(unit: str) -> dict[str, Any]:
    rc, out, err = _systemctl([
        "show", unit, "--no-page",
        "--property=LoadState,ActiveState,UnitFileState,SubState",
    ])
    if rc is None:
        return {"enabled": None, "active": None, "diagnostic": "systemctl unavailable: " + err[:200]}
    if rc != 0:
        # A missing unit reports non-zero; that is not the same as disabled.
        return {"enabled": None, "active": None, "diagnostic": err.strip()[:200] or "unit not found"}
    fields: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            fields[key.strip()] = value.strip()
    unit_file_state = fields.get("UnitFileState") or ""
    active_state = fields.get("ActiveState") or ""
    enabled = {
        "enabled": True, "enabled-runtime": True, "static": False, "disabled": False,
        "masked": False, "generated": True, "indirect": False, "transient": True,
    }.get(unit_file_state)
    active = {
        "active": True, "activating": True, "reloading": True, "deactivating": True,
        "inactive": False, "failed": False, "unknown": None,
    }.get(active_state)
    diag: list[str] = []
    if enabled is None:
        diag.append("UnitFileState=" + str(fields.get("UnitFileState")))
    if active is None:
        diag.append("ActiveState=" + str(fields.get("ActiveState")))
    out_dict: dict[str, Any] = {"enabled": enabled, "active": active}
    if diag:
        out_dict["diagnostic"] = "; ".join(diag)
    return out_dict


def units_status() -> dict[str, Any]:
    timer, path_unit = _show("icon-normalizer.timer"), _show("icon-normalizer.path")
    states = [u.get("enabled") for u in (timer, path_unit)] + [
        u.get("active") for u in (timer, path_unit)
    ]
    if any(v is None for v in states):
        automatic = "unknown"
    elif all(u["enabled"] and u["active"] for u in (timer, path_unit)):
        automatic = "on"
    elif all(u["enabled"] is False and u["active"] is False for u in (timer, path_unit)):
        automatic = "off"
    else:
        automatic = "partial"

    def clean(unit: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {"enabled": unit.get("enabled"), "active": unit.get("active")}
        if unit.get("diagnostic"):
            out["diagnostic"] = unit["diagnostic"]
        return out

    return {
        "timer": clean(timer),
        "path": clean(path_unit),
        "automatic": automatic,
        "available": not (timer.get("enabled") is None and timer.get("active") is None),
    }


def _matches(status: dict[str, Any], enabled: bool) -> bool:
    want = bool(enabled)
    for unit in ("timer", "path"):
        if status[unit]["enabled"] is not want or status[unit]["active"] is not want:
            return False
    return True


def set_enabled(enabled: bool, timeout: float = 25.0) -> dict[str, Any]:
    """enable --now / disable --now both triggers; restores prior state on failure."""
    before = units_status()
    if not _known(before):
        return {"ok": False, "units": before, "before": before,
                "diagnostic": "Cannot change unknown trigger state"}
    results: dict[str, Any] = {}
    ok_all = True
    action = ["enable", "--now"] if enabled else ["disable", "--now"]
    for unit in UNITS:
        rc, out, err = _systemctl([*action, unit], timeout=timeout)
        results[unit] = {"ok": rc == 0, "detail": (err.strip() or out.strip())[:200]}
        ok_all &= rc == 0
    after = units_status()
    if not ok_all or not _matches(after, enabled):
        # restore pre-operation trigger state as far as possible
        restored = restore_units(before, timeout)
        return {
            "ok": False,
            "units": restored["units"],
            "before": before,
            "restored": restored["ok"],
            "diagnostic": "automation change failed; prior states restored"
                if restored["ok"] else "automation change and compensation failed",
        }
    return {"ok": True, "units": after, "before": before}


def _known(status: dict[str, Any]) -> bool:
    return all(isinstance(status.get(name, {}).get(key), bool)
               for name in ("timer", "path") for key in ("enabled", "active"))


def restore_units(before: dict[str, Any], timeout: float = 25.0) -> dict[str, Any]:
    """Restore each enabled and active bit independently, then verify."""
    if not _known(before):
        return {"ok": False, "units": units_status(), "diagnostic": "Unknown prior state"}
    ok = True
    for name, unit in zip(("timer", "path"), UNITS):
        state = before[name]
        for action in ("enable" if state["enabled"] else "disable",
                       "start" if state["active"] else "stop"):
            rc, _out, _err = _systemctl([action, unit], timeout=timeout)
            ok = ok and rc == 0
    after = units_status()
    exact = all(after[name][key] is before[name][key]
                for name in ("timer", "path") for key in ("enabled", "active"))
    return {"ok": ok and exact, "units": after}


def wait_service_idle(timeout: float = 60.0) -> bool:
    """Return True when icon-normalizer.service is neither activating nor running."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rc, out, _err = _systemctl([
            "show", SERVICE_UNIT, "--no-page", "--property=ActiveState",
        ])
        if rc == 0:
            value = ""
            for line in out.splitlines():
                if line.startswith("ActiveState="):
                    value = line.split("=", 1)[1].strip()
            if value in ("inactive", "failed"):
                return True
        time.sleep(0.4)
    return False
