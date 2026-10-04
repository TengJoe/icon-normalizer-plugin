"""Preview generation: reuses the exact core rendering pipeline used by apply.

Never writes the production theme/desktop/baseline/manifest/last-run/GSettings.
The cache lives only in the dedicated preview root with an LRU budget.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image

from .config_store import ConfigStore
from .errors import ProtocolError, reject
from .policy import Policy, validate_policy_values
from .version import CORE_VERSION
from .xdg import RuntimePaths
from .core.analyzer import analyze
from .core.renderer import fit_original, normalize
from .core.resolver import load_image, lookup_size_specific

CACHE_BUDGET = 32 * 1024 * 1024
MAX_PNG = 2 * 1024 * 1024


def hash_icon_name(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()


def cache_key(
    source_sha: str,
    policy: dict[str, Any],
    size: int,
    cls: str | None,
    skipped: bool,
) -> str:
    basis = json.dumps(
        {"sha": source_sha, "policy": policy, "size": size, "class": cls,
         "skipped": skipped, "core": CORE_VERSION},
        sort_keys=True,
    )
    return hashlib.sha256(basis.encode()).hexdigest()


def lru_trim(root: Path, budget: int = CACHE_BUDGET) -> None:
    files = sorted(root.glob("*.png"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for p in files:
        if total <= budget:
            break
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


def png_base64(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    data = buf.getvalue()
    if len(data) > MAX_PNG:
        raise ProtocolError("IO_ERROR", "preview PNG exceeds 2 MiB envelope")
    return base64.b64encode(data).decode()


def load_png(path: Path) -> Image.Image:
    with Image.open(path) as im:
        return im.convert("RGBA")


def slot_original(
    group: dict[str, Any],
    size: int,
    source_path: str | None,
    paths: RuntimePaths,
    search_path: list[str] | None,
) -> Image.Image:
    """The actual resolved artwork for this size from the ORIGINAL theme, never our overlay."""
    icon_name = group.get("icon_name")
    try:
        if icon_name and not str(icon_name).startswith("/"):
            hit = lookup_size_specific(
                str(icon_name), size, str(group.get("base_theme") or "hicolor"),
                search_path, paths.theme_dir,
            )
            if hit is not None:
                img, _ = load_image(hit, size)
                return fit_original(img, size)
    except Exception:
        pass
    try:
        if source_path:
            img, _ = load_image(source_path, size)
            return fit_original(img, size)
    except Exception:
        pass
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def preview(
    args: dict[str, Any],
    *,
    paths: RuntimePaths,
    store: ConfigStore,
    policy: Policy,
    revision: str,
    search_path: list[str] | None = None,
) -> dict[str, Any]:
    """args already validated: icon_id, source_sha256, size, draft."""
    draft: dict[str, Any] = args.get("draft") or {}
    effective_target = float(draft.get("target", policy.target))
    effective_deadband = float(draft.get("deadband", policy.deadband))
    effective_inner = float(draft.get("inner", policy.inner))
    try:
        validate_policy_values(effective_target, effective_deadband, effective_inner)
    except ValueError as exc:
        reject("INVALID_CONFIG", str(exc))
    effective = {
        "target": effective_target,
        "deadband": effective_deadband,
        "inner": effective_inner,
        "sizes": list(policy.sizes),
        "base_theme": policy.base_theme,
    }

    # Identity comes from the last valid scan; arbitrary paths are rejected by design.
    scan = None
    if paths.last_scan_path.exists():
        try:
            scan = json.loads(paths.last_scan_path.read_text())
        except Exception:
            scan = None
    group = None
    if scan:
        for candidate in scan.get("groups", []):
            if candidate["icon_id"] == args["icon_id"]:
                group = candidate
                break
    if group is None:
        reject("NOT_FOUND", "图标组不存在或尚未扫描；请先执行 scan",
               details={"icon_id": args["icon_id"]})
    if group.get("source_sha256") != args["source_sha256"]:
        reject("STALE_SOURCE", "源素材已更新；请刷新扫描",
               details={"current_source_sha256": group.get("source_sha256")})

    rules = store.load_rules().get("icons", {})
    rule = rules.get(args["icon_id"]) or {}
    skipped = bool(rule.get("skip"))
    cls = group.get("classification")
    source_path = group.get("source_path")

    action = group.get("action") or "keep"
    metrics: dict[str, Any] = {"source_ratio": group.get("source_ratio")}
    original_img: Image.Image
    proposed_img: Image.Image
    key = cache_key(
        args["source_sha256"], effective, args["size"], cls, skipped
    )
    cache_file = paths.preview_root / (key + ".png")
    paths.preview_root.mkdir(parents=True, exist_ok=True)
    if skipped or action in ("keep", "excluded", "unresolved", "retain_previous", "skipped"):
        # keep/skipped: show the real size-specific original artwork, not a rescaled master.
        original_img = slot_original(group, args["size"], source_path, paths, search_path)
        proposed_img = original_img.copy()
        action = "skipped" if skipped else action
        metrics["note"] = (
            "skipped: vendor artwork at this size"
            if skipped
            else "within deadband or excluded: no candidate"
        )
    else:
        if cache_file.exists():
            proposed_img = load_png(cache_file)
        else:
            img, _ = load_image(str(source_path))
            st = analyze(img)
            assert cls is not None
            proposed_img, _ = normalize(
                img, st, cls, args["size"], effective_target, effective_inner
            )
            tmp = paths.preview_root / ("." + key + ".tmp")
            proposed_img.save(tmp, format="PNG")
            os.replace(tmp, cache_file)
            lru_trim(paths.preview_root)
        original_img = slot_original(group, args["size"], source_path, paths, search_path)
        measured = analyze(proposed_img).source_ratio
        metrics = {
            "source_ratio": group.get("source_ratio"),
            "target_ratio": effective_target,
            "size": args["size"],
            "measured_after_ratio": round(measured, 4),
        }
    return {
        "effective_policy": {
            "target": effective_target,
            "deadband": effective_deadband,
            "inner": effective_inner,
        },
        "saved_revision": revision,
        "icon_id": args["icon_id"],
        "icon_name": group.get("icon_name"),
        "source_sha256": group.get("source_sha256"),
        "action": action,
        "skipped": skipped,
        "classification": cls,
        "classification_origin": group.get("classification_origin"),
        "classification_stale": group.get("classification_stale", False),
        "size": args["size"],
        "metrics": metrics,
        "original_png_base64": png_base64(original_img),
        "proposed_png_base64": png_base64(proposed_img),
    }
