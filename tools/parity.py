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

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from icon_normalizer.core.analyzer import analyze, classify, suggest_class  # noqa: E402
from icon_normalizer.core.renderer import normalize  # noqa: E402
from icon_normalizer.core.resolver import load_image  # noqa: E402

FLOAT_TOL = 1e-9

#: Rendering parity thresholds. Measured worst case above 16 px is 7.09/255, so
#: 8 leaves headroom. At 16 px a glyph plate is only 9-13 px wide, so one pixel
#: of rounding is over 8% of the image; the fixed-point correction loop is
#: genuinely chaotic there and 12 is the honest bound.
MEAN_ABS_MAX = 8.0
MEAN_ABS_MAX_16 = 12.0
SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512)
PER_CLASS = 4
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


def class_samples(per_class: int) -> list[tuple[str, str]]:
    """One (class, path) pair per icon, capped per class."""
    state = Path.home() / ".local/state/icon-normalizer/manifest.json"
    data = json.loads(state.read_text())
    by_class: dict[str, list[str]] = {}
    for item in data.get("items", {}).values():
        cls, path = item.get("class"), item.get("source_path")
        if cls and path and Path(path).exists():
            bucket = by_class.setdefault(cls, [])
            if path not in bucket:
                bucket.append(str(path))
    return [(cls, path) for cls, paths in sorted(by_class.items())
            for path in sorted(paths)[:per_class]]


def compare_render(verbose: bool) -> int:
    samples = class_samples(PER_CLASS)
    if not samples:
        raise SystemExit("no icons with a recorded class; run the backend once first")
    outdir = Path("/tmp/parity-render")
    outdir.mkdir(parents=True, exist_ok=True)
    for stale in outdir.glob("*.png"):
        stale.unlink()

    jobs = {"outdir": str(outdir), "jobs": [
        {"path": path, "cls": cls, "sizes": list(SIZES), "target": 0.83, "inner": 0.7}
        for cls, path in samples
    ]}
    job_file = Path("/tmp/parity-render.json")
    job_file.write_text(json.dumps(jobs))

    proc = subprocess.run(
        ["gjs", "-m", str(PROJECT / "tests/gjs/dump-render.js"), str(job_file)],
        capture_output=True, text=True, timeout=1800,
    )
    if proc.returncode != 0:
        raise SystemExit("gjs render failed:\n" + proc.stderr[-2000:])
    rendered = json.loads(proc.stdout.strip().splitlines()[-1])

    print(f"  comparing rendering for {len(samples)} icons x {len(SIZES)} sizes")
    failures: list[str] = []
    worst_mean = 0.0
    worst_name = ""
    comparisons = 0
    for row in rendered:
        name = Path(row["path"]).name
        cls = row["cls"]
        if not row["ok"]:
            failures.append(f"{name}: gjs failed ({row.get('error')})")
            continue
        image, _meta = load_image(row["path"])
        metrics = analyze(image)
        for entry in row["renders"]:
            size = entry["size"]
            want, want_info = normalize(image, metrics, cls, size=size, target=0.83, inner=0.7)
            produced = outdir / f"{row['index']}-{size}.png"
            if not produced.exists():
                failures.append(f"{name}@{size}: gjs output missing")
                continue
            got = Image.open(produced).convert("RGBA")
            if got.size != want.size:
                failures.append(f"{name}@{size}: size {got.size} != {want.size}")
                continue
            comparisons += 1
            a = np.asarray(want).astype(int)
            b = np.asarray(got).astype(int)
            diff = np.abs(a - b)
            mean_abs = float(diff.mean())
            if mean_abs > worst_mean:
                worst_mean, worst_name = mean_abs, f"{name}@{size}"
            want_ratio = analyze(want).source_ratio
            got_ratio = analyze(got).source_ratio
            coverage_gap = abs(want_ratio - got_ratio) * size
            info = entry["info"]
            if coverage_gap > 1e-9:
                failures.append(f"{name}@{size}: coverage gap {coverage_gap:.3f} px")
            limit = MEAN_ABS_MAX_16 if size <= 16 else MEAN_ABS_MAX
            if mean_abs > limit:
                failures.append(f"{name}@{size}: mean abs diff {mean_abs:.2f} > {limit}")
            if info.get("plate_color") != want_info.plate_color:
                failures.append(
                    f"{name}@{size}: plate {info.get('plate_color')!r} != {want_info.plate_color!r}")
            if bool(info.get("shadow_clamped")) != bool(want_info.shadow_clamped):
                failures.append(
                    f"{name}@{size}: clamped {info.get('shadow_clamped')} != {want_info.shadow_clamped}")
            if verbose:
                print(f"    ok   {name}@{size} mean={mean_abs:.2f}")
    print()
    if failures:
        print(f"  FAILED: {len(failures)} mismatches over {comparisons} comparisons")
        for line in failures[:40]:
            print("    " + line)
        if len(failures) > 40:
            print(f"    ... and {len(failures) - 40} more")
        return 1
    print(f"  OK: {comparisons} comparisons, worst mean abs diff {worst_mean:.2f}/255 ({worst_name})")
    return 0

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("analyze", "render"))
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.mode == "analyze":
        return compare_analyze(args.limit, args.verbose)
    if args.mode == "render":
        return compare_render(args.verbose)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())