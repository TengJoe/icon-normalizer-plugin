"""Dependency-free render identity; reading status must not import image libraries."""
from typing import Any

from .policy import Policy, canonical_json, sha_hex
from .version import CORE_VERSION


def hash_icon_name(name: str) -> str:
    return sha_hex(name.encode())


def _numeric_canonical(value: Any) -> Any:
    """Fold integral floats to ints so both JSON serializers agree (1.0 vs 1)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: _numeric_canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_numeric_canonical(item) for item in value]
    return value


def policy_fingerprint(policy: Policy) -> str:
    """Engine-agnostic policy fingerprint, shared with the GJS engine.

    Both engines must derive the identical value for the same strategy so a
    manifest written by either is reused by the other without forcing a full
    re-render (the Shell scheduler and the optional Python worker are both
    writers). The rendering core is represented by the shared CORE_VERSION —
    bumped together with the core on semantic changes, per docs/RELEASING.md —
    instead of source hashes, which are engine-specific by definition.
    tools/parity.py asserts the two engines stay byte-identical.
    """
    return sha_hex((canonical_json(_numeric_canonical(policy.strategy_dict()))
                    + CORE_VERSION).encode())
