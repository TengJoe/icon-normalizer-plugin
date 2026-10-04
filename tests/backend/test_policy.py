"""Policy model, validation and revision tests."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer.policy import (  # noqa: E402
    Policy,
    PolicyDefaults,
    SIZE_LADDER,
    compute_revision,
    revision_from_mapping,
    validate_policy,
)


class TestPolicy(unittest.TestCase):
    def test_defaults_match_validated_baseline(self) -> None:
        policy = Policy()
        self.assertEqual(policy.target, 0.88)
        self.assertEqual(policy.deadband, 0.02)
        self.assertEqual(policy.inner, 0.72)
        self.assertEqual(policy.sizes, SIZE_LADDER)
        validate_policy({"target": 0.88, "deadband": 0.02, "inner": 0.72,
                         "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})

    def test_out_of_range_rejected(self) -> None:
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.30, "deadband": 0.02, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.88, "deadband": 0.20, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.88, "deadband": 0.02, "inner": 0.30,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})

    def test_bool_is_not_a_number(self) -> None:
        with self.assertRaises(ValueError):
            validate_policy({"target": True, "deadband": 0.02, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})

    def test_cross_field_rule(self) -> None:
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.60, "deadband": 0.50, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})
        with self.assertRaises(ValueError):
            # target+deadband must not exceed 1.0
            validate_policy({"target": 0.98, "deadband": 0.03, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "hicolor"})

    def test_sizes_ladder_is_frozen(self) -> None:
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.88, "deadband": 0.02, "inner": 0.72,
                             "sizes": [16, 32, 64, 256], "base_theme": "hicolor"})

    def test_base_theme_required(self) -> None:
        with self.assertRaises(ValueError):
            validate_policy({"target": 0.88, "deadband": 0.02, "inner": 0.72,
                             "sizes": list(SIZE_LADDER), "base_theme": "  "})

    def test_revision_is_canonical_and_covers_rules(self) -> None:
        policy = Policy()
        a = compute_revision(policy, {"icon-a": {"skip": True}})
        b = compute_revision(policy, {"icon-a": {"skip": True}})
        self.assertEqual(a, b)
        c = compute_revision(policy, {"icon-a": {"skip": False}})
        self.assertNotEqual(a, c)
        d = compute_revision(Policy(target=0.90), {})
        self.assertNotEqual(a, d)
        # rule map ordering must not matter
        e = compute_revision(policy, {"x": {"skip": True}, "y": {"skip": False}})
        f = compute_revision(policy, {"y": {"skip": False}, "x": {"skip": True}})
        self.assertEqual(e, f)

    def test_revision_from_mapping_matches_dataclass(self) -> None:
        raw = {"target": 0.88, "deadband": 0.02, "inner": 0.72,
               "sizes": list(SIZE_LADDER), "base_theme": "Yaru"}
        self.assertEqual(
            revision_from_mapping(raw, {}),
            compute_revision(Policy(base_theme="Yaru"), {}),
        )

    def test_defaults_factory(self) -> None:
        defaults = PolicyDefaults(base_theme="FixtureBase")
        policy = defaults.policy()
        self.assertEqual(policy.base_theme, "FixtureBase")
        self.assertEqual(json.dumps(policy.to_dict(), sort_keys=True),
                         json.dumps({**policy.to_dict()}, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
