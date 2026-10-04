"""Policy/user-rules persistence: schema migration, atomic writes, overrides.

The backend is the only writer of config.json / user-rules.json. Callers must
hold sync.lock before calling load(); this module never locks by itself.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from .policy import (
    Policy,
    PolicyDefaults,
    SIZE_LADDER,
    SCHEMA_VERSION,
    validate_policy,
)


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    """Use the common symlink-safe, durable atomic writer."""
    from .core.transaction import atomic_write as write
    write(path, data, mode)


def read_json_file(path: Path) -> Any | None:
    try:
        return json.loads(Path(path).read_text()) if Path(path).exists() else None
    except Exception:
        return None


def write_json_file(path: Path, payload: Any, mode: int = 0o600) -> None:
    atomic_write(Path(path), json.dumps(payload, ensure_ascii=False, indent=1).encode(), mode)


def migrate_policy(data: Any, defaults: PolicyDefaults) -> Policy:
    """Accept schema v1/v2 documents, merge over defaults, validate."""
    if not isinstance(data, dict):
        raise ValueError("config.json must be an object")
    for key in ('target', 'deadband', 'inner'):
        if key in data and (isinstance(data[key], bool) or not isinstance(data[key], (int, float))):
            raise ValueError(f'config.{key} must be a number')
    if 'base_theme' in data and (not isinstance(data['base_theme'], str) or not data['base_theme'].strip()):
        raise ValueError('config.base_theme must be a non-empty string')
    version = data.get("schema_version", 1)
    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError('config.schema_version must be an integer')
    if version == 1:
        version = SCHEMA_VERSION
    if version != SCHEMA_VERSION:
        raise ValueError(f"unsupported config schema_version {version}")
    policy = Policy(
        target=float(data.get("target", defaults.target)),
        deadband=float(data.get("deadband", defaults.deadband)),
        inner=float(data.get("inner", defaults.inner)),
        sizes=SIZE_LADDER,
        base_theme=str(data.get("base_theme") or defaults.base_theme),
    )
    _validate_policy_object(policy)
    return policy


def _validate_policy_object(policy: Policy) -> None:
    validate_policy({
        "target": policy.target,
        "deadband": policy.deadband,
        "inner": policy.inner,
        "sizes": list(policy.sizes),
        "base_theme": policy.base_theme,
    })


class ConfigStore:
    """Owns config.json (policy) and user-rules.json. Caller holds the lock."""

    def __init__(self, state_dir: Path, defaults: PolicyDefaults | None = None) -> None:
        self.state_dir = Path(state_dir)
        self.config_path = self.state_dir / "config.json"
        self.rules_path = self.state_dir / "user-rules.json"
        self.defaults = defaults or PolicyDefaults()

    # ---------- loading ----------
    def load_policy(self) -> Policy:
        if not self.config_path.exists():
            return self.defaults.policy()
        data = json.loads(self.config_path.read_text())
        return migrate_policy(data, self.defaults)

    def load_rules(self) -> dict[str, Any]:
        if not self.rules_path.exists():
            return {"schema_version": 1, "icons": {}}
        data: dict[str, Any] = json.loads(self.rules_path.read_text())
        if data.get("schema_version") != 1 or not isinstance(data.get("icons"), dict):
            raise ValueError("user-rules.json is corrupt")
        return data

    # ---------- writing ----------
    def policy_document(self, policy: Policy) -> dict[str, Any]:
        return {"schema_version": SCHEMA_VERSION, **policy.to_dict()}

    def write_policy_if_changed(self, policy: Policy) -> bool:
        """Persist unless the stored document is already semantically identical."""
        document = self.policy_document(policy)
        if self.config_path.exists():
            try:
                if json.loads(self.config_path.read_text()) == document:
                    return False
            except Exception:
                pass
        atomic_write(
            self.config_path,
            json.dumps(document, ensure_ascii=False, indent=2).encode(),
        )
        return True

    def write_rules_if_changed(self, rules: Mapping[str, Any]) -> bool:
        document = dict(rules)
        if self.rules_path.exists():
            try:
                if json.loads(self.rules_path.read_text()) == document:
                    return False
            except Exception:
                pass
        atomic_write(
            self.rules_path, json.dumps(document, ensure_ascii=False, indent=2).encode()
        )
        return True

    # ---------- revision ----------
    def revision(self, policy: Policy | None = None, rules: Mapping[str, Any] | None = None) -> str:
        from .policy import compute_revision

        effective = policy or self.load_policy()
        icons = (rules if rules is not None else self.load_rules()).get("icons", {})
        return compute_revision(effective, icons)

    # ---------- patching ----------
    def apply_patch(self, policy: Policy, patch: Mapping[str, Any]) -> Policy:
        updated = Policy(
            target=float(patch.get("target", policy.target)),
            deadband=float(patch.get("deadband", policy.deadband)),
            inner=float(patch.get("inner", policy.inner)),
            sizes=policy.sizes,
            base_theme=policy.base_theme,
        )
        _validate_policy_object(updated)
        return updated


def load_overrides(libexec: Path, state_dir: Path) -> dict[str, Any]:
    """Merged reviewed classifications.

    The shipped ``overrides.json`` next to the package holds portable entries
    (theme icon names only). A machine-specific ``<state>/overrides.json`` may
    add entries for absolute-path icons; the state file wins on key collision.
    """
    overrides: dict[str, Any] = {}
    overrides.update(_read_override_file(Path(libexec) / "overrides.json"))
    overrides.update(_read_override_file(Path(state_dir) / "overrides.json"))
    return overrides


def _read_override_file(path: Path) -> dict[str, Any]:
    try:
        if not path.exists():
            return {}
        data = json.loads(path.read_text())
        icons = data.get("icons", {})
        return {str(k): v for k, v in icons.items()} if isinstance(icons, dict) else {}
    except Exception:
        return {}
