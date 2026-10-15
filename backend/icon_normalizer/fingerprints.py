"""Dependency-free render identity; reading status must not import image libraries."""
from pathlib import Path

from .policy import Policy, canonical_json, sha_hex


def hash_icon_name(name: str) -> str:
    return sha_hex(name.encode())


def policy_fingerprint(policy: Policy) -> str:
    core = Path(__file__).with_name("core")
    return sha_hex((canonical_json(policy.strategy_dict())
                    + sha_hex((core / "analyzer.py").read_bytes())
                    + sha_hex((core / "renderer.py").read_bytes())).encode())
