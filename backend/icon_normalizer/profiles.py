"""Named visual presets. Caller holds sync.lock; profiles never bind a theme."""
from __future__ import annotations

import json
import unicodedata
import uuid
from pathlib import Path
from typing import Any

from .core.transaction import atomic_write, safe_path
from .errors import reject
from .policy import canonical_json, sha_hex, validate_policy_values

MAX_PROFILES = 50
VISUAL_KEYS = ("target", "deadband", "inner")


def validate_name(value: Any) -> str:
    if not isinstance(value, str):
        reject("INVALID_REQUEST", "profile name must be a string")
    name = unicodedata.normalize("NFC", value.strip())
    if not 1 <= len(name) <= 64 or any(unicodedata.category(c).startswith("C") for c in name):
        reject("INVALID_CONFIG", "profile name requires 1..64 printable characters",
               details={"reason": "PROFILE_NAME_INVALID"})
    return name


def validate_parameters(value: Any) -> dict[str, float]:
    if not isinstance(value, dict) or set(value) != set(VISUAL_KEYS):
        reject("INVALID_REQUEST", "profile parameters require target, deadband and inner only")
    if any(isinstance(value[k], bool) or not isinstance(value[k], (int, float)) for k in VISUAL_KEYS):
        reject("INVALID_REQUEST", "profile parameters must be finite numbers")
    result = {k: float(value[k]) for k in VISUAL_KEYS}
    try:
        validate_policy_values(**result)
    except ValueError as exc:
        reject("INVALID_CONFIG", str(exc))
    return result


class ProfilesStore:
    def __init__(self, state: Path) -> None:
        self.path = state / "profiles.json"

    def load(self) -> dict[str, Any]:
        try:
            path = safe_path(self.path)
        except ValueError as exc:
            reject("OWNERSHIP_CONFLICT", str(exc))
        if not path.exists():
            return {"schema_version": 1, "profiles": []}
        if path.stat().st_size > 128 * 1024:
            reject("INVALID_CONFIG", "profiles.json exceeds 128 KiB")
        try:
            data = json.loads(path.read_text())
        except (ValueError, OSError) as exc:
            reject("INVALID_CONFIG", f"profiles.json unreadable: {exc}")
        if not isinstance(data, dict) or data.get("schema_version") != 1 or set(data) != {"schema_version", "profiles"}:
            reject("INVALID_CONFIG", "profiles.json has an unsupported schema")
        profiles = data.get("profiles")
        if not isinstance(profiles, list) or len(profiles) > MAX_PROFILES:
            reject("INVALID_CONFIG", "profiles.json has an invalid profile list")
        ids: set[str] = set()
        names: set[str] = set()
        for profile in profiles:
            if not isinstance(profile, dict) or set(profile) != {"id", "name", "parameters"}:
                reject("INVALID_CONFIG", "profiles.json has an invalid profile")
            identifier = profile["id"]
            if not isinstance(identifier, str) or len(identifier) != 32 or any(c not in "0123456789abcdef" for c in identifier):
                reject("INVALID_CONFIG", "profiles.json has an invalid id")
            name = validate_name(profile["name"])
            validate_parameters(profile["parameters"])
            if identifier in ids or name.casefold() in names:
                reject("INVALID_CONFIG", "profiles.json has duplicate profiles")
            ids.add(identifier)
            names.add(name.casefold())
        return data

    def catalog(self) -> dict[str, Any]:
        document = self.load()
        return {"profiles_revision": sha_hex(canonical_json(document).encode()),
                "profiles": document["profiles"]}

    def _current(self, expected: str) -> dict[str, Any]:
        current = self.catalog()
        if current["profiles_revision"] != expected:
            reject("REVISION_CONFLICT", "profiles changed; refresh before saving",
                   details={"current_profiles_revision": current["profiles_revision"]})
        return current

    def _write(self, profiles: list[dict[str, Any]]) -> dict[str, Any]:
        document = {"schema_version": 1, "profiles": profiles}
        encoded = json.dumps(document, ensure_ascii=False, indent=2).encode()
        if not self.path.exists() or json.loads(self.path.read_text()) != document:
            atomic_write(self.path, encoded, 0o600)
        return self.catalog()

    def save(self, args: dict[str, Any]) -> dict[str, Any]:
        current = self._current(args["expected_profiles_revision"])
        profiles = list(current["profiles"])
        name = validate_name(args["name"])
        parameters = validate_parameters(args["parameters"])
        identifier = args.get("profile_id")
        if identifier is not None and not any(p["id"] == identifier for p in profiles):
            reject("NOT_FOUND", "profile no longer exists")
        if any(p["name"].casefold() == name.casefold() and p["id"] != identifier for p in profiles):
            reject("INVALID_CONFIG", "a profile with this name already exists",
                   details={"reason": "PROFILE_NAME_EXISTS"})
        if identifier is None and len(profiles) >= MAX_PROFILES:
            reject("INVALID_CONFIG", "at most 50 profiles are supported",
                   details={"reason": "PROFILE_LIMIT"})
        identifier = identifier or uuid.uuid4().hex
        profile = {"id": identifier, "name": name, "parameters": parameters}
        if any(p["id"] == identifier for p in profiles):
            profiles = [profile if p["id"] == identifier else p for p in profiles]
        else:
            profiles.append(profile)
        return {**self._write(profiles), "profile": profile}

    def delete(self, args: dict[str, Any]) -> dict[str, Any]:
        current = self._current(args["expected_profiles_revision"])
        profiles = current["profiles"]
        if not any(p["id"] == args["profile_id"] for p in profiles):
            reject("NOT_FOUND", "profile no longer exists")
        return self._write([p for p in profiles if p["id"] != args["profile_id"]])
