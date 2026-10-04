"""Error codes, exit codes and the protocol error type.

The code table is frozen by ``contracts/response.schema.json``; unknown codes are
treated as retryable so newer backends can add codes without breaking older UIs.
"""
from __future__ import annotations

from typing import Any, NoReturn

EXIT_OK = 0
EXIT_OTHER = 1
EXIT_INPUT = 2
EXIT_BUSY = 3
EXIT_NOT_INSTALLED = 4
EXIT_CONFLICT = 5

RETRYABLE = frozenset({"BUSY", "REVISION_CONFLICT", "STALE_SOURCE", "TIMEOUT"})
NON_RETRYABLE = frozenset({
    "INVALID_REQUEST", "UNSUPPORTED_VERSION", "INVALID_CONFIG", "NOT_INSTALLED",
    "DEPENDENCY_MISSING", "UNSUPPORTED_ENVIRONMENT", "NOT_FOUND", "SOURCE_UNAVAILABLE",
    "RECOVERY_REQUIRED", "OWNERSHIP_CONFLICT", "AUTOMATION_FAILED", "IO_ERROR",
    "INTERNAL_ERROR",
})

_INPUT_CODES = ("INVALID_REQUEST", "UNSUPPORTED_VERSION", "INVALID_CONFIG")
_NOT_INSTALLED_CODES = ("NOT_INSTALLED", "DEPENDENCY_MISSING", "UNSUPPORTED_ENVIRONMENT")
_CONFLICT_CODES = ("STALE_SOURCE", "RECOVERY_REQUIRED", "OWNERSHIP_CONFLICT", "AUTOMATION_FAILED")
_BUSY_CODES = ("BUSY", "REVISION_CONFLICT")


def is_retryable(code: str) -> bool:
    if code in RETRYABLE:
        return True
    if code in NON_RETRYABLE:
        return False
    return True


def exit_code_for(code: str) -> int:
    if code in _BUSY_CODES:
        return EXIT_BUSY
    if code in _NOT_INSTALLED_CODES:
        return EXIT_NOT_INSTALLED
    if code in _CONFLICT_CODES:
        return EXIT_CONFLICT
    if code in _INPUT_CODES:
        return EXIT_INPUT
    return EXIT_OTHER


class ProtocolError(Exception):
    """A failure that must cross the wire as a structured error envelope."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool | None = None,
        details: dict[str, Any] | None = None,
        request_id: str | None = None,
        operation: str | None = None,
        exit_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = is_retryable(code) if retryable is None else retryable
        self.details: dict[str, Any] = details or {}
        self.request_id = request_id
        self.operation = operation
        self.exit_code = exit_code if exit_code is not None else exit_code_for(code)


def reject(code: str, message: str, **kwargs: Any) -> NoReturn:
    """Raise a ProtocolError; reads better than ``raise`` at call sites."""
    raise ProtocolError(code, message, **kwargs)
