"""Shared rule identity and classification for apply and preview."""
from __future__ import annotations

from typing import Any

from ..policy import sha_hex
from .analyzer import CLASSES, Classification, IconMetrics, classify


def lookup_rule(rules: dict[str, dict[str, Any]], icon: str) -> dict[str, Any] | None:
    # Protocol v1 persists SHA-256 icon IDs. Older direct-engine callers may
    # still provide icon names; the canonical protocol ID takes precedence.
    return rules.get(sha_hex(icon.encode())) or rules.get(icon)


def resolve_rule(rule: dict[str, Any] | None, digest: str | None) -> dict[str, Any] | None:
    if not rule or rule.get("reset"):
        return None
    if rule.get("skip"):
        return {"skip": True, "class": None}
    cls = rule.get("classification")
    if cls == "auto":
        return {"skip": False, "class": None, "drop_manual": True}
    if cls not in CLASSES:
        return None
    if rule.get("source_sha256") and digest != rule["source_sha256"]:
        return None
    return {"skip": False, "class": cls}


def classify_source(icon: str, digest: str, metrics: IconMetrics,
                    overrides: dict[str, dict[str, Any]],
                    rules: dict[str, dict[str, Any]]) -> tuple[Classification, str]:
    automatic = classify(metrics)
    result = automatic
    override = overrides.get(icon)
    if override and digest == override.get("source_sha256"):
        result = Classification(str(override["class"]),
                                str(override.get("reason", "reviewed_override")), "reviewed")
    rule = resolve_rule(lookup_rule(rules, icon), digest)
    if rule:
        if rule.get("drop_manual"):
            result = Classification(automatic.cls, "automatic_classification", "automatic")
        elif rule.get("class"):
            result = Classification(str(rule["class"]), "user_classification", "user")
    return result, automatic.cls
