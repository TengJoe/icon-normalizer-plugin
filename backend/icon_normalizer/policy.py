"""Policy model: validation, defaults and the OCC revision token.

The nine-rung size ladder and the validated parameter baseline are frozen
design constants (see ARCHITECTURE.md §4); ``revision`` covers the strategy
keys plus user rules and is the only concurrency token writers exchange.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Mapping

SCHEMA_VERSION = 2

DEFAULT_TARGET = 0.88
DEFAULT_DEADBAND = 0.02
DEFAULT_INNER = 0.72

#: The fixed nine-rung native size ladder; files are provided at every rung so
#: desktop renderers never float-interpolate.
SIZE_LADDER: tuple[int, ...] = (16, 24, 32, 48, 64, 96, 128, 256, 512)

RANGES: dict[str, tuple[float, float]] = {
    "target": (0.50, 0.98),
    "deadband": (0.0, 0.10),
    "inner": (0.40, 0.95),
}

CLASSES = ("plate-rect", "plate-circle", "artwork", "glyph")

POLICY_KEYS = ("target", "deadband", "inner", "sizes", "base_theme")


@dataclass(frozen=True)
class Policy:
    target: float = DEFAULT_TARGET
    deadband: float = DEFAULT_DEADBAND
    inner: float = DEFAULT_INNER
    sizes: tuple[int, ...] = SIZE_LADDER
    base_theme: str = "hicolor"

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "deadband": self.deadband,
            "inner": self.inner,
            "sizes": list(self.sizes),
            "base_theme": self.base_theme,
        }

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "Policy":
        sizes = data.get("sizes", SIZE_LADDER)
        return cls(
            target=float(data["target"]),
            deadband=float(data["deadband"]),
            inner=float(data["inner"]),
            sizes=tuple(int(n) for n in sizes),
            base_theme=str(data["base_theme"]),
        )

    def strategy_dict(self) -> dict[str, Any]:
        """The keys that participate in revision and policy hashing."""
        return {
            "target": self.target,
            "deadband": self.deadband,
            "inner": self.inner,
            "sizes": list(self.sizes),
            "base_theme": self.base_theme,
        }


def validate_policy_values(target: float, deadband: float, inner: float) -> None:
    """Range and cross-field validation; raises ValueError with a stable message."""
    values = {"target": target, "deadband": deadband, "inner": inner}
    for key, (lo, hi) in RANGES.items():
        value = values[key]
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"policy.{key} not finite")
        if not (lo <= value <= hi):
            raise ValueError(f"policy.{key} out of range [{lo},{hi}]")
    if not (0 < target - deadband and target + deadband <= 1):
        raise ValueError("cross-field rule violated: 0 < target-deadband and target+deadband <= 1")


def validate_policy(policy: Mapping[str, Any]) -> None:
    """Validate a raw policy mapping (wire/config representation)."""
    for key, (lo, hi) in RANGES.items():
        value = policy.get(key)
        # bool is an int subclass; the protocol explicitly rejects it as a number.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"policy.{key} must be a number")
        if not (lo <= float(value) <= hi) or not float(value) == float(value):
            raise ValueError(f"policy.{key} out of range")
    validate_policy_values(
        float(policy["target"]), float(policy["deadband"]), float(policy["inner"])
    )
    if tuple(policy.get("sizes", ())) != SIZE_LADDER:
        raise ValueError("policy.sizes must be the fixed nine-size ladder")
    base = policy.get("base_theme")
    if not isinstance(base, str) or not base.strip():
        raise ValueError("policy.base_theme must be a non-empty string")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sha_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_revision(policy: Policy, user_rules: Mapping[str, Any]) -> str:
    """Canonical-policy SHA-256: strategy keys + user rules; no paths, no timestamps."""
    basis = {"policy": policy.strategy_dict(), "user_rules": dict(user_rules)}
    return sha_hex(canonical_json(basis).encode())


def revision_from_mapping(policy: Mapping[str, Any], user_rules: Mapping[str, Any]) -> str:
    """Revision for raw policy mappings (used by control over store output)."""
    return compute_revision(Policy.from_mapping(policy), user_rules)


@dataclass(frozen=True)
class PolicyDefaults:
    """Factory defaults applied when config.json is absent or partial."""

    target: float = DEFAULT_TARGET
    deadband: float = DEFAULT_DEADBAND
    inner: float = DEFAULT_INNER
    base_theme: str = "hicolor"

    def policy(self) -> Policy:
        return Policy(
            target=self.target,
            deadband=self.deadband,
            inner=self.inner,
            sizes=SIZE_LADDER,
            base_theme=self.base_theme,
        )
