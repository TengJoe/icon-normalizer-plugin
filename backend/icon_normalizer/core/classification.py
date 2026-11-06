"""Shared rule identity and classification for apply and preview."""
from __future__ import annotations

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


def lookup_rule(rules: dict[str, dict[str, Any]], icon: str) -> dict[str, Any] | None:
    # Protocol v1 persists SHA-256 icon IDs. Older direct-engine callers may
    # still provide icon names; the canonical protocol ID takes precedence.
    return rules.get(sha_hex(icon.encode())) or rules.get(icon)


def describe_rule(
    rule: dict[str, Any] | None, digest: str | None
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
        return None, state, {"expected_sha256": expected, "actual_sha256": digest}
    return {"skip": False, "class": cls}, RULE_STATE_ACTIVE, {"classification": cls}


def resolve_rule(rule: dict[str, Any] | None, digest: str | None) -> dict[str, Any] | None:
    return describe_rule(rule, digest)[0]


def classify_source_ex(
    icon: str,
    digest: str,
    metrics: IconMetrics,
    overrides: dict[str, dict[str, Any]],
    rules: dict[str, dict[str, Any]],
) -> tuple[Classification, str, str, dict[str, Any]]:
    """Like classify_source() but also returns the user-rule state."""
    automatic = classify(metrics)
    result = automatic
    override = overrides.get(icon)
    if override and digest == override.get("source_sha256"):
        result = Classification(str(override["class"]),
                                str(override.get("reason", "reviewed_override")), "reviewed")
    decision, state, detail = describe_rule(lookup_rule(rules, icon), digest)
    if decision:
        if decision.get("drop_manual"):
            result = Classification(automatic.cls, "automatic_classification", "automatic")
        elif decision.get("class"):
            result = Classification(str(decision["class"]), "user_classification", "user")
    return result, automatic.cls, state, detail


def classify_source(icon: str, digest: str, metrics: IconMetrics,
                    overrides: dict[str, dict[str, Any]],
                    rules: dict[str, dict[str, Any]]) -> tuple[Classification, str]:
    result, automatic, _state, _detail = classify_source_ex(
        icon, digest, metrics, overrides, rules)
    return result, automatic
