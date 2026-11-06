"""Shared rule identity and classification for apply and preview."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ..policy import sha_hex
from .analyzer import CLASSES, Classification, IconMetrics, classify


# Rule outcome states. A rule that exists but does not apply must stay
# observable: silently falling back to automatic classification hides the
# reason an icon stops matching its reviewed appearance.
RULE_STATE_NONE = "none"
RULE_STATE_ACTIVE = "active"
RULE_STATE_STALE = "stale_source"
RULE_STATE_UNBOUND = "unbound"
RULE_STATE_INVALID = "invalid"

ALERT_RULE_STATES = frozenset({RULE_STATE_STALE, RULE_STATE_UNBOUND, RULE_STATE_INVALID})


def lookup_rule_ex(
    rules: dict[str, dict[str, Any]],
    icon: str,
    path_by_key: dict[str, str] | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """Return (rule, matched_by) with matched_by in {exact, basename, none}.

    Exact matches (protocol SHA-256 ID, then raw icon string) always win. When
    neither matches, a rule whose stored key shares the icon's file name is
    reused -- application updates often re-export the same artwork into a
    different size directory (256x256 -> 512x512), which would otherwise drop
    the rule silently. Only an unambiguous single candidate is accepted.
    """
    exact = rules.get(sha_hex(icon.encode())) or rules.get(icon)
    if exact is not None:
        return exact, "exact"
    base = Path(icon).name
    if not base:
        return None, "none"

    def key_path(key: str) -> str:
        # Protocol v1 keys are SHA-256 digests of the source path, so the file
        # name is only recoverable through the previous run manifest.
        if path_by_key and key in path_by_key:
            return path_by_key[key]
        return key

    matches = [(key, value) for key, value in rules.items()
               if Path(key_path(key)).name == base]
    if len(matches) == 1:
        return matches[0][1], "basename"
    return None, "none"


def lookup_rule(rules: dict[str, dict[str, Any]], icon: str) -> dict[str, Any] | None:
    # Protocol v1 persists SHA-256 icon IDs. Older direct-engine callers may
    # still provide icon names; the canonical protocol ID takes precedence.
    return lookup_rule_ex(rules, icon)[0]


def describe_rule(
    rule: dict[str, Any] | None, digest: str | None, matched_by: str = "exact"
) -> tuple[dict[str, Any] | None, str, dict[str, Any]]:
    """Resolve a user rule and explain the outcome.

    Returns (decision, state, detail). decision has the same shape as
    resolve_rule(); state is one of the RULE_STATE_* values so callers can
    report a rule that exists but no longer applies.
    """
    if not rule or rule.get("reset"):
        return None, RULE_STATE_NONE, {}
    if rule.get("skip"):
        return {"skip": True, "class": None}, RULE_STATE_ACTIVE, {"mode": "skip"}
    # "class" is accepted as an alias for the portable override schema.
    cls = rule.get("classification") or rule.get("class")
    if cls == "auto":
        return {"skip": False, "class": None, "drop_manual": True}, RULE_STATE_ACTIVE, {"mode": "auto"}
    if cls not in CLASSES:
        return None, RULE_STATE_INVALID, {"classification": cls}
    expected = rule.get("source_sha256")
    if expected and digest != expected:
        state = RULE_STATE_STALE if digest else RULE_STATE_UNBOUND
        return None, state, {"expected_sha256": expected, "actual_sha256": digest,
                             "matched_by": matched_by}
    return {"skip": False, "class": cls}, RULE_STATE_ACTIVE, {
        "classification": cls, "matched_by": matched_by}


def resolve_rule(rule: dict[str, Any] | None, digest: str | None) -> dict[str, Any] | None:
    return describe_rule(rule, digest)[0]


def classify_source_ex(
    icon: str,
    digest: str,
    metrics: IconMetrics,
    overrides: dict[str, dict[str, Any]],
    rules: dict[str, dict[str, Any]],
    path_by_key: dict[str, str] | None = None,
) -> tuple[Classification, str, str, dict[str, Any]]:
    """Like classify_source() but also returns the user-rule state."""
    automatic = classify(metrics)
    result = automatic
    override = overrides.get(icon)
    if override and digest == override.get("source_sha256"):
        result = Classification(str(override["class"]),
                                str(override.get("reason", "reviewed_override")), "reviewed")
    raw_rule, matched_by = lookup_rule_ex(rules, icon, path_by_key)
    decision, state, detail = describe_rule(raw_rule, digest, matched_by)
    if decision:
        if decision.get("drop_manual"):
            result = Classification(automatic.cls, "automatic_classification", "automatic")
        elif decision.get("class"):
            result = Classification(str(decision["class"]), "user_classification", "user")
    return result, automatic.cls, state, detail


def classify_source(icon: str, digest: str, metrics: IconMetrics,
                    overrides: dict[str, dict[str, Any]],
                    rules: dict[str, dict[str, Any]],
                    path_by_key: dict[str, str] | None = None) -> tuple[Classification, str]:
    result, automatic, _state, _detail = classify_source_ex(
        icon, digest, metrics, overrides, rules, path_by_key)
    return result, automatic
