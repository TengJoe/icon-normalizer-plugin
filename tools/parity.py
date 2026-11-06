#!/usr/bin/env python3
"""Parity harness: compare the GJS engine against the Python reference.

Usage:
    python3 tools/parity.py analyze [--limit N] [--verbose]

The Python backend stays the oracle until the GJS port is complete. Every
comparison prints a summary and exits non-zero on a mismatch.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "backend"))

from icon_normalizer.core.analyzer import analyze, classify, suggest_class  # noqa: E402
from icon_normalizer.core.resolver import load_image  # noqa: E402

FLOAT_TOL = 1e-9
FIELDS = (
    "core_bbox", "full_bbox", "source_ratio", "strict_ratio", "width_ratio",
    "height_ratio", "fill", "ring", "ellipse_iou", "aspect", "cx", "cy",
    "corner_alpha",
)


def icon_paths(limit: int | None) -> list[str]:
    """Source icons recorded in the current manifest, deduplicated."""
    state = Path.home() / ".local/state/icon-normalizer/manifest.json"
    if not state.exists():
        raise SystemExit("no manifest found; run the backend once first")
    data = json.loads(state.read_text())
    seen: dict[str, None] = {}
    for item in data.get("items", {}).values():
        path = item.get("source_path")
        if path and Path(path).exists():
            seen.setdefault(str(path), None)
    paths = sorted(seen)
    return paths[:limit] if limit else paths


def python_metrics(path: str) -> dict:
    image, _meta = load_image(path)
    metrics = analyze(image)
    result = classify(metrics)
    return {
        "metrics": {field: getattr(metrics, field) for field in FIELDS},
        "classification": {"cls": result.cls, "reason": result.reason,
                           "confidence": result.confidence},
        "suggested": suggest_class(metrics),
    }


def gjs_metrics(paths: list[str]) -> dict[str, dict]:
    proc = subprocess.run(
        ["gjs", "-m", str(PROJECT / "tests/gjs/dump-analyze.js"), *paths],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        raise SystemExit("gjs dump failed:\n" + proc.stderr[-2000:])
    rows = json.loads(proc.stdout.strip().splitlines()[-1])
    return {row["path"]: row for row in rows}


def compare_analyze(limit: int | None, verbose: bool) -> int:
    paths = icon_paths(limit)
    print(f"  comparing analysis for {len(paths)} icons")
    reference = gjs_metrics(paths)
    failures: list[str] = []
    checked = 0
    for path in paths:
        name = Path(path).name
        got = reference.get(path)
        if not got or not got.get("ok"):
            failures.append(f"{name}: gjs failed ({got.get('error') if got else 'missing'})")
            continue
        try:
            want = python_metrics(path)
        except Exception as exc:  # noqa: BLE001 - report, do not abort the run
            failures.append(f"{name}: python failed ({exc})")
            continue
        checked += 1
        for field in FIELDS:
            a, b = want["metrics"][field], got["metrics"][field]
            if isinstance(a, (list, tuple)):
                same = list(a) == list(b)
            elif a is None or b is None:
                same = a is b
            elif isinstance(a, float):
                same = abs(a - b) <= FLOAT_TOL
            else:
                same = a == b
            if not same:
                failures.append(f"{name}: {field} python={a!r} gjs={b!r}")
        for key in ("cls", "reason", "confidence"):
            if want["classification"][key] != got["classification"][key]:
                failures.append(
                    f"{name}: classification.{key} python={want['classification'][key]!r} "
                    f"gjs={got['classification'][key]!r}")
        if want["suggested"] != got["suggested"]:
            failures.append(f"{name}: suggested python={want['suggested']!r} gjs={got['suggested']!r}")
        if verbose and not any(f.startswith(name) for f in failures):
            print(f"    ok   {name}")
    print()
    if failures:
        print(f"  FAILED: {len(failures)} mismatches over {checked} icons")
        for line in failures[:40]:
            print("    " + line)
        if len(failures) > 40:
            print(f"    ... and {len(failures) - 40} more")
        return 1
    print(f"  OK: {checked} icons match on {len(FIELDS)} metrics, classification and suggestion")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("analyze",))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.mode == "analyze":
        return compare_analyze(args.limit, args.verbose)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
