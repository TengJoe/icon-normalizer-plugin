"""v1 wire protocol: strict JSON parsing, validation, error envelope.

Everything that can fail before/outside business logic must still emit a
parseable JSON object on stdout. stdout never carries diagnostics.
"""
from __future__ import annotations

import json
import math
import re
import sys
from typing import Any, Callable

from .errors import ProtocolError, reject
from .version import API_VERSION

MAX_STDIN = 64 * 1024
MAX_STDOUT = 8 * 1024 * 1024

OPERATIONS = (
    "status", "doctor", "scan", "preview", "configure",
    "rules.set", "apply", "automation.set", "revert",
    "profiles.list", "profiles.save", "profiles.delete", "theme.follow", "theme.sync",
)

TARGET_RANGE = (0.50, 0.98)
DEADBAND_RANGE = (0.0, 0.10)
INNER_RANGE = (0.40, 0.95)
SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512)

_REQUEST_ID_RE = re.compile(r"[A-Za-z0-9_.:\-]+")
_HEX64_RE = re.compile(r"[0-9a-f]{64}")

_ParsedRequest = tuple[dict[str, Any], str, str, dict[str, Any]]


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite JSON constant: {name}")


def _finite_number(value: Any, field: str) -> float:
    # bool is an int subclass; policy explicitly rejects it as a number.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        reject("INVALID_REQUEST", f"{field} must be a finite number", exit_code=2)
    if not math.isfinite(float(value)):
        reject("INVALID_REQUEST", f"{field} must be a finite number", exit_code=2)
    return float(value)


def _no_unknown(payload: dict[str, Any], allowed: tuple[str, ...] | list[str], where: str) -> None:
    unknown = sorted(set(payload) - set(allowed))
    if unknown:
        reject(
            "INVALID_REQUEST",
            f"unknown field(s) in {where}: " + ", ".join(unknown),
            exit_code=2,
        )


def parse_request(raw: bytes) -> _ParsedRequest:
    if len(raw) > MAX_STDIN:
        reject("INVALID_REQUEST", "request body exceeds 64 KiB", exit_code=2)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        reject("INVALID_REQUEST", "request is not valid UTF-8", exit_code=2)
    try:
        payload = json.loads(text, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        reject("INVALID_REQUEST", "request is not valid JSON: " + str(exc), exit_code=2)
    except ValueError as exc:
        reject(
            "INVALID_REQUEST",
            "request contains " + str(exc).replace("non-finite JSON constant: ", "non-finite constant "),
            exit_code=2,
        )
    if not isinstance(payload, dict):
        reject("INVALID_REQUEST", "request must be a JSON object", exit_code=2)
    _no_unknown(payload, ("api_version", "request_id", "operation", "arguments"), "request")
    if "api_version" not in payload:
        reject("INVALID_REQUEST", "api_version is required", exit_code=2)
    if payload["api_version"] != API_VERSION or isinstance(payload["api_version"], bool):
        reject("UNSUPPORTED_VERSION", f"api_version must be {API_VERSION}", exit_code=2)
    rid = payload.get("request_id")
    if not isinstance(rid, str) or not (1 <= len(rid) <= 96) or not _REQUEST_ID_RE.fullmatch(rid):
        reject("INVALID_REQUEST", "request_id must be 1..96 chars of [A-Za-z0-9_.:-]", exit_code=2)
    op = payload.get("operation")
    if op not in OPERATIONS:
        reject("INVALID_REQUEST", "unknown operation", exit_code=2)
    args = payload.get("arguments", {})
    if not isinstance(args, dict):
        reject("INVALID_REQUEST", "arguments must be an object", exit_code=2)
    return payload, rid, str(op), args


def parse_patch(args: dict[str, Any]) -> dict[str, float]:
    _no_unknown(args, ("target", "deadband", "inner"), "patch")
    if not args:
        reject("INVALID_REQUEST", "patch requires at least one field", exit_code=2)
    patch: dict[str, float] = {}
    for key, (lo, hi) in (("target", TARGET_RANGE), ("deadband", DEADBAND_RANGE), ("inner", INNER_RANGE)):
        if key in args:
            value = _finite_number(args[key], f"patch.{key}")
            if not (lo <= value <= hi):
                reject("INVALID_CONFIG", f"patch.{key} out of range [{lo},{hi}]", exit_code=2)
            patch[key] = value
    if "target" in patch and "deadband" in patch:
        target = patch["target"]
        deadband = patch["deadband"]
        if not (0 < target - deadband and target + deadband <= 1):
            reject(
                "INVALID_CONFIG",
                "requires 0 < target-deadband and target+deadband <= 1",
                exit_code=2,
            )
    return patch


def _require_hex(args: dict[str, Any], key: str, where: str, message: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not _HEX64_RE.fullmatch(value):
        reject("INVALID_REQUEST", message, exit_code=2)
    return value


def parse_preview(args: dict[str, Any]) -> dict[str, Any]:
    _no_unknown(args, ("icon_id", "source_sha256", "size", "draft"), "preview")
    missing = [k for k in ("icon_id", "source_sha256", "size") if k not in args]
    if missing:
        reject("INVALID_REQUEST", "preview requires " + ", ".join(missing), exit_code=2)
    icon_id = _require_hex(args, "icon_id", "preview", "preview.icon_id must be a 64-hex id")
    source_sha = _require_hex(args, "source_sha256", "preview", "preview.source_sha256 must be a 64-hex id")
    size = args["size"]
    if isinstance(size, bool) or not isinstance(size, int) or size not in SIZES:
        reject("INVALID_REQUEST", "preview.size must be one of the nine supported sizes", exit_code=2)
    draft = parse_patch(args["draft"]) if "draft" in args else {}
    return {"icon_id": icon_id, "source_sha256": source_sha, "size": size, "draft": draft}


def parse_configure(args: dict[str, Any]) -> dict[str, Any]:
    _no_unknown(args, ("expected_revision", "patch"), "configure")
    for key in ("expected_revision", "patch"):
        if key not in args:
            reject("INVALID_REQUEST", f"configure requires {key}", exit_code=2)
    expected = _require_hex(
        args, "expected_revision", "configure", "expected_revision must be a 64-hex revision"
    )
    if not isinstance(args["patch"], dict):
        reject("INVALID_REQUEST", "configure.patch must be an object", exit_code=2)
    return {"expected_revision": expected, "patch": parse_patch(args["patch"])}


def parse_rules(args: dict[str, Any]) -> dict[str, Any]:
    _no_unknown(args, ("expected_revision", "icon_id", "rule"), "rules.set")
    for key in ("expected_revision", "icon_id", "rule"):
        if key not in args:
            reject("INVALID_REQUEST", f"rules.set requires {key}", exit_code=2)
    expected = _require_hex(
        args, "expected_revision", "rules.set", "expected_revision must be a 64-hex revision"
    )
    icon_id = _require_hex(args, "icon_id", "rules.set", "icon_id must be a 64-hex id")
    rule = args["rule"]
    if not isinstance(rule, dict):
        reject("INVALID_REQUEST", "rule must be an object", exit_code=2)
    if set(rule) == {"reset"} and rule.get("reset") is True:
        return {"expected_revision": expected, "icon_id": icon_id, "rule": {"reset": True}}
    _no_unknown(rule, ("skip", "classification", "source_sha256"), "rule")
    if "skip" not in rule or "classification" not in rule:
        reject("INVALID_REQUEST", "rule requires skip and classification (or reset:true)", exit_code=2)
    if not isinstance(rule["skip"], bool):
        reject("INVALID_REQUEST", "rule.skip must be a boolean", exit_code=2)
    cls = rule["classification"]
    if cls not in ("auto", "plate-rect", "plate-circle", "artwork", "glyph"):
        reject("INVALID_REQUEST", "rule.classification invalid", exit_code=2)
    if "source_sha256" in rule and cls == "auto":
        reject("INVALID_REQUEST", "classification=auto must not carry source_sha256", exit_code=2)
    if cls != "auto":
        if "source_sha256" not in rule:
            reject("INVALID_REQUEST", "manual classification requires source_sha256", exit_code=2)
        if not isinstance(rule["source_sha256"], str) or not _HEX64_RE.fullmatch(rule["source_sha256"]):
            reject("INVALID_REQUEST", "source_sha256 must be 64-hex", exit_code=2)
    return {"expected_revision": expected, "icon_id": icon_id, "rule": rule}


def parse_apply(args: dict[str, Any]) -> dict[str, Any]:
    _no_unknown(args, ("expected_revision", "activate"), "apply")
    if "expected_revision" not in args or "activate" not in args:
        reject("INVALID_REQUEST", "apply requires expected_revision and activate", exit_code=2)
    expected = _require_hex(
        args, "expected_revision", "apply", "expected_revision must be a 64-hex revision"
    )
    if not isinstance(args["activate"], bool):
        reject("INVALID_REQUEST", "activate must be a boolean", exit_code=2)
    return {"expected_revision": expected, "activate": args["activate"]}


def parse_automation(args: dict[str, Any]) -> dict[str, Any]:
    _no_unknown(args, ("enabled",), "automation.set")
    if "enabled" not in args or not isinstance(args["enabled"], bool):
        reject("INVALID_REQUEST", "automation.set requires boolean enabled", exit_code=2)
    return {"enabled": args["enabled"]}


def parse_profile(args: dict[str, Any], deleting: bool = False) -> dict[str, Any]:
    from .profiles import validate_name, validate_parameters
    allowed = ("expected_profiles_revision", "profile_id") if deleting else (
        "expected_profiles_revision", "profile_id", "name", "parameters")
    _no_unknown(args, allowed, "profile")
    expected = _require_hex(args, "expected_profiles_revision", "profile",
                            "expected_profiles_revision must be a 64-hex revision")
    identifier = args.get("profile_id")
    if deleting or "profile_id" in args:
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
            reject("INVALID_REQUEST", "profile_id must be a 32-hex id", exit_code=2)
    result: dict[str, Any] = {"expected_profiles_revision": expected}
    if identifier is not None:
        result["profile_id"] = identifier
    if not deleting:
        result["name"] = validate_name(args.get("name"))
        result["parameters"] = validate_parameters(args.get("parameters"))
    return result


def _empty_args(args: dict[str, Any], op: str) -> None:
    _no_unknown(args, (), op or "arguments")


ARG_PARSERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "preview": parse_preview,
    "configure": parse_configure,
    "rules.set": parse_rules,
    "apply": parse_apply,
    "automation.set": parse_automation,
    "profiles.save": parse_profile,
    "profiles.delete": lambda args: parse_profile(args, deleting=True),
    "theme.follow": parse_automation,
}


def validate(op: str, args: dict[str, Any]) -> dict[str, Any]:
    if op in ("status", "doctor", "scan", "revert", "profiles.list", "theme.sync"):
        _empty_args(args, op)
        return {}
    parser = ARG_PARSERS.get(op)
    if parser is None:
        reject("INVALID_REQUEST", "unknown operation", exit_code=2)
    return parser(args)


def response_ok(request_id: str | None, operation: str | None, result: Any, warnings: Any = None) -> dict[str, Any]:
    return {
        "api_version": API_VERSION,
        "request_id": request_id,
        "operation": operation,
        "ok": True,
        "result": result,
        "warnings": warnings or [],
    }


def response_err(exc: ProtocolError) -> dict[str, Any]:
    return {
        "api_version": API_VERSION,
        "request_id": exc.request_id,
        "operation": exc.operation,
        "ok": False,
        "error": {
            "code": exc.code,
            "message": exc.message,
            "retryable": bool(exc.retryable),
            "details": exc.details,
        },
    }


def emit(payload: dict[str, Any]) -> None:
    """Write exactly one JSON line to stdout, enforcing the 8 MiB envelope limit."""
    text = json.dumps(payload, ensure_ascii=False)
    if len(text.encode()) > MAX_STDOUT:
        text = json.dumps({
            "api_version": API_VERSION,
            "request_id": payload.get("request_id"),
            "operation": payload.get("operation"),
            "ok": False,
            "error": {
                "code": "IO_ERROR",
                "message": "response exceeded 8 MiB envelope limit",
                "retryable": False,
                "details": {},
            },
        }, ensure_ascii=False)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
