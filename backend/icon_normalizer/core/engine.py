"""Normalization engine: scan → classify → decide → render → transact.

Orchestration only; the math lives in :mod:`analyzer`/:mod:`renderer` and disk
safety in :mod:`transaction`. Concurrency model: the main thread performs every
``Gtk.IconTheme`` lookup and owns all decisions and disk checks; worker threads
only decode (GdkPixbuf file loading is thread safe) and run PIL/numpy analysis
or rendering. Results are collected per icon, so output ordering is
deterministic regardless of worker scheduling.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import gsettings
from ..config_store import atomic_write
from ..desktop import (
    DesktopRef,
    collect_desktop_entries,
    read_desktop_section,
    rewrite_icon_line,
)
from ..gsettings import ThemeSettings
from ..policy import Policy, canonical_json, sha_hex
from ..theme import MARKER, MANIFEST_VERSION, MARKER_FILE, ThemeDirectory, theme_index
from .analyzer import IconMetrics, Plan, analyze, classify, plan
from .renderer import normalize
from .resolver import IconResolver, load_image, resolve_source
from .transaction import ProtectedRoot, TransactionStore

_THEME_NAME_RE = re.compile(r"[A-Za-z0-9_.+-]+")


def default_max_workers() -> int:
    override = os.environ.get("ICON_NORMALIZER_WORKERS")
    if override and override.isdigit() and int(override) > 0:
        return int(override)
    return max(2, min(4, os.cpu_count() or 2))


@dataclass(frozen=True)
class EngineConfig:
    home: Path
    theme_dir: Path
    theme_name: str
    state_dir: Path
    user_applications: Path
    desktop: str
    policy: Policy
    overrides: dict[str, dict[str, Any]]
    user_rules: dict[str, dict[str, Any]]
    application_dirs: tuple[str, ...] | None = None
    icon_search_path: tuple[str, ...] | None = None
    settings: ThemeSettings | None = None
    max_workers: int = field(default_factory=default_max_workers)
    previous_source_theme: str | None = None


@dataclass
class InspectResult:
    changes: dict[Path, bytes | None]
    manifest: dict[str, Any]
    payload: dict[str, Any]


@dataclass
class _IconPlan:
    """Everything the main thread needs to materialize one icon."""

    icon: str
    path: Path
    digest: str
    refs: list[DesktopRef]
    names: list[str]
    desktop_ids: list[str]
    metrics: IconMetrics
    cls: str
    confidence: str
    decision: Plan
    row: dict[str, Any]
    output_name: str
    input_key: str
    prior: dict[str, Any] | None
    reusable: bool


def _png_bytes(image: Any) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _analyzer_bytes() -> bytes:
    from . import analyzer

    return Path(analyzer.__file__).read_bytes()


def _renderer_bytes() -> bytes:
    from . import renderer

    return Path(renderer.__file__).read_bytes()


def policy_fingerprint(policy: Policy) -> str:
    """Cache-invalidation hash: policy keys + analyzer/renderer source bytes."""
    return sha_hex(
        (
            canonical_json(policy.strategy_dict())
            + sha_hex(_analyzer_bytes())
            + sha_hex(_renderer_bytes())
        ).encode()
    )


class Engine:
    """Owns one overlay theme and its state directory. Caller holds sync.lock."""

    def __init__(self, config: EngineConfig) -> None:
        self.config = config
        if config.policy.base_theme == config.theme_name:
            raise ValueError("Source and generated theme must be different")
        self.theme_dir = config.theme_dir
        self.state_dir = config.state_dir
        self.apps_dir = config.user_applications
        self.base_theme = config.policy.base_theme
        self.theme_name = config.theme_name
        self.resolver = IconResolver(
            base_theme=self.base_theme,
            search_path=list(config.icon_search_path) if config.icon_search_path else None,
        )
        self.themedir = ThemeDirectory(self.theme_dir, self.theme_name)
        self.store = TransactionStore(
            journal_path=self.state_dir / "pending.json",
            roots=[
                ProtectedRoot(path=self.theme_dir, file_mode=0o644),
                ProtectedRoot(path=self.state_dir, file_mode=0o600),
                ProtectedRoot(path=self.apps_dir, file_mode=0o644),
            ],
            finalize=self._finalize_cache,
        )
        self.policy_sha = policy_fingerprint(config.policy)
        self.analysis_policy = sha_hex(
            (
                self.policy_sha
                + canonical_json(config.overrides)
                + canonical_json(config.user_rules)
            ).encode()
        )

    # ------------------------------------------------------------------ basics
    def manifest(self) -> dict[str, Any]:
        path = self.state_dir / "manifest.json"
        if not path.exists():
            return {
                "version": MANIFEST_VERSION,
                "base_theme": self.base_theme,
                "items": {},
                "desktop_overrides": {},
            }
        data: dict[str, Any] = json.loads(path.read_text())
        if data["base_theme"] != self.base_theme and data["base_theme"] != self.config.previous_source_theme:
            raise ValueError("Baseline changed; revert before changing source theme")
        return data

    def allowed(self, path: Path) -> Path:
        return self.store.allowed(path)

    def cache_valid(self) -> bool:
        return self.themedir.cache_valid()

    def rebuild_cache(self) -> None:
        self.themedir.rebuild()

    def _finalize_cache(self, changed: bool) -> None:
        if changed or not self.cache_valid():
            self.rebuild_cache()

    def recover(self) -> bool:
        return self.store.recover()

    # ------------------------------------------------------------------ inputs
    def user_rule(self, icon: str, digest: str | None) -> dict[str, Any] | None:
        """Validated user rule for an icon, or None. Manual classes bind to the SHA."""
        rule = self.config.user_rules.get(icon)
        if not rule:
            return None
        if rule.get("reset"):
            return None
        cls = rule.get("classification")
        if rule.get("skip"):
            return {"skip": True, "class": None}
        if cls == "auto":
            return {"skip": False, "class": None, "drop_manual": True}
        if cls not in ("plate-rect", "plate-circle", "artwork", "glyph"):
            return None
        if rule.get("source_sha256"):
            if digest is None:
                try:
                    digest = sha_hex(resolve_source(icon, self.resolver).read_bytes())
                except Exception:
                    digest = None
            if digest != rule["source_sha256"]:
                return None
        return {"skip": False, "class": cls}

    def collect(
        self, old: dict[str, Any]
    ) -> tuple[dict[str, list[DesktopRef]], dict[str, int], list[dict[str, str]]]:
        return collect_desktop_entries(
            self.config.desktop,
            self.config.home,
            entry_transform=self._entry_transform(old.get("desktop_overrides", {})),
            application_dirs=list(self.config.application_dirs)
            if self.config.application_dirs is not None
            else None,
        )

    def _entry_transform(self, managed: dict[str, Any]) -> Any:
        def transform(path: Path, entry: dict[str, str]) -> dict[str, str] | None:
            record = managed.get(str(path))
            if not record:
                return entry
            data = path.read_bytes()
            # Our generated launcher points to its generated absolute icon path.
            if entry.get("Icon") != record["output_icon"]:
                return entry
            if record["original_existed"]:
                # Preserve non-Icon edits made since installation.
                return read_desktop_section(rewrite_icon_line(data, record["source_icon"]))
            source = Path(record["source_desktop"])
            if not source.is_file():
                return None
            # A locally edited generated launcher is treated as a user launcher.
            if sha_hex(data) != record["output_sha256"]:
                return read_desktop_section(rewrite_icon_line(data, record["source_icon"]))
            return read_desktop_section(source.read_bytes())

        return transform

    # ------------------------------------------------------------------ inspect
    def inspect(self) -> InspectResult:
        old = self.manifest()
        owned = self.themedir.owned()
        grouped, counts, errors = self.collect(old)
        if errors:
            raise ValueError(
                "Desktop entries could not be parsed: " + json.dumps(errors, ensure_ascii=False)
            )

        items: dict[str, dict[str, Any]] = {}
        analysis_cache: dict[str, dict[str, Any]] = {}
        rows: list[dict[str, Any]] = []
        unresolved: list[dict[str, str]] = []
        changes: dict[Path, bytes | None] = {}
        desired_desktops: dict[str, dict[str, Any]] = {}
        used_overrides: set[str] = set()
        backup_data: dict[Path, bytes] = {}

        old_cache = old.get("analysis_cache", {})
        old_items = old.get("items", {})
        policy = self.config.policy
        sizes = list(policy.sizes)

        # ---- phase A: exclusions, resolution, analysis-cache dispatch ----
        order: list[str] = []
        refs_by_icon: dict[str, list[DesktopRef]] = {}
        resolved: dict[str, tuple[Path, str]] = {}
        analysis_jobs: list[tuple[str, Path, str]] = []
        analysis_failures: dict[str, str] = {}
        for icon, refs in sorted(grouped.items()):
            order.append(icon)
            if not any(r.visibility == "visible" for r in refs):
                rows.append({
                    "icon_name": icon,
                    "action": "excluded",
                    "names": [r.name for r in refs],
                    "desktop_ids": [r.desktop_id for r in refs],
                })
                continue
            refs_by_icon[icon] = refs
            try:
                path = resolve_source(icon, self.resolver, forbidden_dir=self.theme_dir)
                digest = sha_hex(path.read_bytes())
            except Exception as exc:
                # Unresolvable sources fall into the retain-previous path below.
                analysis_failures[icon] = str(exc)
                continue
            resolved[icon] = (path, digest)
            analysis_key = sha_hex((str(path) + digest + self.analysis_policy).encode())
            cached = old_cache.get(icon)
            if cached and cached["key"] == analysis_key:
                analysis_cache[icon] = cached
            else:
                analysis_jobs.append((icon, path, digest))

        # ---- phase B: concurrent analysis of cache misses ----------------
        analysis_results: dict[str, dict[str, Any]] = {}
        if analysis_jobs:
            with ThreadPoolExecutor(max_workers=self.config.max_workers) as pool:
                futures: dict[Any, str] = {
                    pool.submit(self._analyze_one, icon, path, digest): icon
                    for icon, path, digest in analysis_jobs
                }
                for future, icon in futures.items():
                    try:
                        analysis_results[icon] = future.result()
                    except Exception as exc:  # per-icon isolation
                        analysis_failures[icon] = str(exc)

        # ---- phase C: decisions, skips, render dispatch -------------------
        plans: dict[str, _IconPlan] = {}
        render_jobs: list[tuple[str, Path, IconMetrics, str, list[int]]] = []
        for icon in order:
            if icon not in refs_by_icon:
                continue
            refs = refs_by_icon[icon]
            names = [r.name for r in refs]
            desktop_ids = [r.desktop_id for r in refs]
            if icon in analysis_failures:
                self._retain_previous(
                    icon, names, desktop_ids, analysis_failures[icon], old, old_cache, items,
                    analysis_cache, desired_desktops, used_overrides, rows, unresolved,
                )
                continue
            path, digest = resolved[icon]
            analysis = analysis_results.get(icon)
            if analysis is not None:
                metrics = analysis["metrics"]
                cls = analysis["class"]
                reason = analysis["reason"]
                confidence = analysis["confidence"]
                analysis_cache[icon] = analysis["cache_entry"]
                auto_class = analysis["auto_class"] or cls
            else:
                cached = analysis_cache[icon]
                metrics = IconMetrics.from_dict(cached["metrics"])
                cls, reason, confidence = cached["class"], cached["reason"], cached["confidence"]
                auto_class = cls
            decision = plan(metrics, cls, policy.target, policy.deadband, policy.inner)
            row = {
                "icon_name": icon,
                "names": names,
                "desktop_ids": desktop_ids,
                "source_path": str(path),
                "source_sha256": digest,
                "class": cls,
                "classification_reason": reason,
                "classification_confidence": confidence,
                "auto_class": auto_class,
                "source_ratio": metrics.source_ratio,
                **decision.as_dict(),
            }
            raw_rule = self.config.user_rules.get(icon)
            if raw_rule and raw_rule.get("skip"):
                row["action"] = "skipped"
                row["reason"] = "user_skip"
                self._apply_skip(icon, path, digest, row, old, items, desired_desktops, changes)
                rows.append(row)
                continue
            rows.append(row)
            if decision.action == "keep":
                continue
            absolute = Path(icon).is_absolute()
            if not absolute and not _THEME_NAME_RE.fullmatch(icon):
                unresolved.append({"icon_name": icon, "error": "Unsupported theme icon name"})
                continue
            output_name = ("docknormalized-" + sha_hex(icon.encode())[:16]) if absolute else icon
            prior = old_items.get(icon)
            input_key = sha_hex((str(path) + digest + cls + self.policy_sha).encode())
            reusable = bool(prior and prior.get("input_key") == input_key)
            # Disk/ownership pass: verify every managed target before rendering.
            missing_sizes = self._verify_targets(icon, output_name, sizes, prior, reusable)
            plan_record = _IconPlan(
                icon=icon, path=path, digest=digest, refs=refs, names=names,
                desktop_ids=desktop_ids, metrics=metrics, cls=cls, confidence=confidence,
                decision=decision, row=row, output_name=output_name, input_key=input_key,
                prior=prior, reusable=reusable,
            )
            plans[icon] = plan_record
            if missing_sizes:
                render_jobs.append((icon, path, metrics, cls, missing_sizes))

        # ---- phase D: concurrent rendering --------------------------------
        render_outputs: dict[str, dict[int, tuple[bytes, dict[str, Any]]]] = {}
        if render_jobs:
            with ThreadPoolExecutor(max_workers=self.config.max_workers) as pool:
                futures = {
                    pool.submit(self._render_sizes, icon, path, metrics, cls, job_sizes): icon
                    for icon, path, metrics, cls, job_sizes in render_jobs
                }
                for future, icon in futures.items():
                    render_outputs[icon] = future.result()  # render failures abort the run

        # ---- phase E: materialize per icon --------------------------------
        for icon in order:
            record = plans.get(icon)
            if record is None:
                continue
            self._materialize(
                record, sizes, render_outputs.get(icon, {}),
                old, items, changes, desired_desktops, used_overrides, backup_data,
            )

        # ---- phase F: stale cleanup + manifest -----------------------------
        wanted = {p for item in items.values() for p in item.get("files", {})}
        for item in old_items.values():
            for p, digest in item.get("files", {}).items():
                target = Path(p)
                if p not in wanted and target.exists():
                    if sha_hex(target.read_bytes()) != digest:
                        raise RuntimeError(f"Manually modified stale icon: {target}")
                    changes[target] = None
        for p, record in old.get("desktop_overrides", {}).items():
            if p in used_overrides:
                continue
            target = Path(p)
            if target.exists():
                current = target.read_bytes()
                if sha_hex(current) == record["output_sha256"]:
                    changes[target] = (
                        base64.b64decode(record["original_data"])
                        if record["original_existed"]
                        else None
                    )
                elif read_desktop_section(current).get("Icon") == record["output_icon"]:
                    # Restore only Icon= and retain the user's other edits.
                    changes[target] = rewrite_icon_line(current, record["source_icon"])
                # A user-changed Icon= is left intact and its record is released.
        new = {
            "version": MANIFEST_VERSION,
            "base_theme": self.base_theme,
            "policy_sha256": self.policy_sha,
            "analysis_cache": analysis_cache,
            "items": items,
            "desktop_overrides": desired_desktops,
        }
        index = theme_index(self.theme_name, self.base_theme, sizes)
        index_path = self.theme_dir / "index.theme"
        if not index_path.exists() or index_path.read_bytes() != index:
            changes[index_path] = index
        if not owned:
            changes[self.theme_dir / MARKER_FILE] = MARKER.encode()
        for p, data in backup_data.items():
            if not p.exists():
                changes[p] = data
        summary = {
            "candidate_icons": len(grouped),
            "visible_desktop_entries": counts.get("visible", 0),
            "actions": dict(Counter(str(r["action"]) for r in rows)),
            "managed_icons": len(items),
            "managed_desktop_overrides": len(desired_desktops),
            "unresolved": unresolved,
            "planned_file_changes": len(changes),
            "cache_valid": self.cache_valid(),
            "source_theme": self.base_theme,
            "active_theme": gsettings.current_icon_theme(self.config.settings),
        }
        return InspectResult(
            changes=changes,
            manifest=new,
            payload={"ok": True, "summary": summary, "warnings": unresolved, "apps": rows},
        )

    # ------------------------------------------------------------- workers
    def _analyze_one(self, icon: str, path: Path, digest: str) -> dict[str, Any]:
        img, _meta = load_image(path)
        metrics = analyze(img)
        auto = classify(metrics)
        cls, reason, confidence = auto.cls, auto.reason, auto.confidence
        override = self.config.overrides.get(icon)
        if override and digest == override.get("source_sha256"):
            cls = str(override["class"])
            reason = str(override.get("reason", "reviewed_override"))
            confidence = "reviewed"
        urule = self.user_rule(icon, digest)
        if urule:
            if urule.get("drop_manual"):
                auto2 = classify(metrics)
                cls, reason, confidence = auto2.cls, "automatic_classification", "automatic"
            elif urule.get("class"):
                cls, reason, confidence = str(urule["class"]), "user_classification", "user"
        return {
            "metrics": metrics,
            "class": cls,
            "reason": reason,
            "confidence": confidence,
            "auto_class": auto.cls if cls != auto.cls else None,
            "cache_entry": {
                "key": sha_hex((str(path) + digest + self.analysis_policy).encode()),
                "metrics": metrics.as_dict(),
                "class": cls,
                "reason": reason,
                "confidence": confidence,
            },
        }

    def _render_sizes(
        self,
        icon: str,
        path: Path,
        metrics: IconMetrics,
        cls: str,
        sizes: list[int],
    ) -> dict[int, tuple[bytes, dict[str, Any]]]:
        img, _meta = load_image(path)
        policy = self.config.policy
        out: dict[int, tuple[bytes, dict[str, Any]]] = {}
        for n in sizes:
            image, info = normalize(img, metrics, cls, n, policy.target, policy.inner)
            out[n] = (_png_bytes(image), info.as_dict())
        return out

    # ------------------------------------------------------- disk verification
    def _verify_targets(
        self,
        icon: str,
        output_name: str,
        sizes: list[int],
        prior: dict[str, Any] | None,
        reusable: bool,
    ) -> list[int]:
        """Ownership checks for every managed target; returns sizes to render."""
        missing: list[int] = []
        prior_files = (prior or {}).get("files", {})
        for n in sizes:
            target = self.theme_dir / f"{n}x{n}" / "apps" / f"{output_name}.png"
            prior_sha = prior_files.get(str(target))
            current = target.read_bytes() if target.is_file() else None
            if current is not None and prior_sha is None:
                raise RuntimeError(f"Unowned icon collision: {target}")
            if current is not None and prior_sha != sha_hex(current):
                raise RuntimeError(f"Generated icon was manually changed: {target}")
            if not (reusable and current is not None):
                missing.append(n)
        return missing

    # ------------------------------------------------------- materialization
    def _materialize(
        self,
        record: _IconPlan,
        sizes: list[int],
        rendered: dict[int, tuple[bytes, dict[str, Any]]],
        old: dict[str, Any],
        items: dict[str, dict[str, Any]],
        changes: dict[Path, bytes | None],
        desired_desktops: dict[str, dict[str, Any]],
        used_overrides: set[str],
        backup_data: dict[Path, bytes],
    ) -> None:
        icon, path, digest, cls = record.icon, record.path, record.digest, record.cls
        prior = record.prior
        prior_files = (prior or {}).get("files", {})
        files: dict[str, str] = {}
        renders: dict[str, dict[str, Any]] = {}
        for n in sizes:
            target = self.theme_dir / f"{n}x{n}" / "apps" / f"{record.output_name}.png"
            current = target.read_bytes() if target.is_file() else None
            if record.reusable and current is not None:
                result = current
                renders[str(n)] = (prior or {}).get("renders", {}).get(str(n), {})
            else:
                if n not in rendered:
                    raise RuntimeError(f"Render output missing for {target}")
                result = rendered[n][0]
                renders[str(n)] = rendered[n][1]
            files[str(target)] = sha_hex(result) or ""
            if current != result:
                changes[target] = result
        items[icon] = {
            "input_key": record.input_key,
            "source_path": str(path),
            "source_sha256": digest,
            "class": cls,
            "files": files,
            "renders": renders,
            "names": record.names,
        }
        if not Path(icon).is_absolute():
            return
        # Absolute-path icons additionally get a content-addressed 256px copy and
        # per-desktop-file overrides under the user applications directory.
        candidate = self.theme_dir / "256x256" / "apps" / f"{record.output_name}.png"
        rendered_candidate = changes.get(candidate)
        if rendered_candidate is None:
            rendered_candidate = candidate.read_bytes() if candidate.exists() else None
        if rendered_candidate is None:
            raise RuntimeError(f"Rendered candidate missing for {candidate}")
        versioned = self.theme_dir / "256x256" / "apps" / (
            f"{record.output_name}-{sha_hex(rendered_candidate)[:16]}.png"
        )
        known = prior_files.get(str(versioned))
        if versioned.exists() and known is None:
            raise RuntimeError(f"Unowned absolute icon collision: {versioned}")
        if versioned.exists() and sha_hex(versioned.read_bytes()) != known:
            raise RuntimeError(f"Absolute icon was manually changed: {versioned}")
        if not versioned.exists():
            changes[versioned] = rendered_candidate
        files[str(versioned)] = sha_hex(rendered_candidate) or ""
        old_overrides = old.get("desktop_overrides", {})
        for ref in record.refs:
            if ref.visibility != "visible":
                continue
            target = self.apps_dir / ref.desktop_id
            source = Path(ref.desktop_path)
            previous = old_overrides.get(str(target))
            if previous:
                current = target.read_bytes() if target.exists() else None
                if current is None:
                    original = base64.b64decode(previous["original_data"])
                    existed = previous["original_existed"]
                    origin = Path(previous["source_desktop"])
                elif read_desktop_section(current).get("Icon") == previous["output_icon"]:
                    if previous["original_existed"] or sha_hex(current) != previous["output_sha256"]:
                        original = rewrite_icon_line(current, icon)
                        existed = True
                        origin = target
                    else:
                        origin = Path(previous["source_desktop"])
                        original = origin.read_bytes()
                        existed = False
                else:
                    original = current
                    existed = True
                    origin = target
            else:
                original = source.read_bytes()
                existed = source == target
                origin = source
                if target.exists() and not existed:
                    raise RuntimeError(f"User desktop override collision: {target}")
            edited = rewrite_icon_line(original, str(versioned))
            desired_desktops[str(target)] = {
                "source_icon": icon,
                "output_icon": str(versioned),
                "original_existed": existed,
                "source_desktop": str(origin),
                "original_data": base64.b64encode(original).decode(),
                "original_sha256": sha_hex(original),
                "output_sha256": sha_hex(edited),
            }
            used_overrides.add(str(target))
            if not target.exists() or target.read_bytes() != edited:
                changes[target] = edited
            backup_data[self.state_dir / "backups" / f"desktop-{sha_hex(original)}.before"] = original

    # ----------------------------------------------------------- skip handling
    def _apply_skip(
        self,
        icon: str,
        path: Path,
        digest: str,
        row: dict[str, Any],
        old: dict[str, Any],
        items: dict[str, dict[str, Any]],
        desired_desktops: dict[str, dict[str, Any]],
        changes: dict[Path, bytes | None],
    ) -> None:
        prior = old.get("items", {}).get(icon)
        if not prior:
            return
        for p, prior_digest in prior.get("files", {}).items():
            target = Path(p)
            if target.exists() and sha_hex(target.read_bytes()) == prior_digest:
                changes[target] = None
        for target_str, record in old.get("desktop_overrides", {}).items():
            if record["source_icon"] != icon:
                continue
            target = Path(target_str)
            current = target.read_bytes() if target.exists() else None
            if current is None:
                if record["original_existed"]:
                    changes[target] = base64.b64decode(record["original_data"])
            elif read_desktop_section(current).get("Icon") == record["output_icon"]:
                changes[target] = rewrite_icon_line(current, record["source_icon"])
        for key in [k for k, v in desired_desktops.items() if v["source_icon"] == icon]:
            del desired_desktops[key]
        items[icon] = {
            "input_key": "skipped:" + sha_hex((str(path) + digest).encode()),
            "source_path": str(path),
            "source_sha256": digest,
            "class": None,
            "files": {},
            "renders": {},
            "names": row["names"],
        }

    # ----------------------------------------------------- unresolved handling
    def _retain_previous(
        self,
        icon: str,
        names: list[str],
        desktop_ids: list[str],
        error: str,
        old: dict[str, Any],
        old_cache: dict[str, Any],
        items: dict[str, dict[str, Any]],
        analysis_cache: dict[str, dict[str, Any]],
        desired_desktops: dict[str, dict[str, Any]],
        used_overrides: set[str],
        rows: list[dict[str, Any]],
        unresolved: list[dict[str, str]],
    ) -> None:
        unresolved.append({"icon_name": icon, "error": error})
        prior = old.get("items", {}).get(icon)
        if prior:
            # A package update may temporarily remove its source artwork.
            # Keep the previous generation while processing other applications.
            items[icon] = prior
            if icon in old_cache:
                analysis_cache[icon] = old_cache[icon]
            for target, record in old.get("desktop_overrides", {}).items():
                if record["source_icon"] == icon:
                    desired_desktops[target] = record
                    used_overrides.add(target)
        rows.append({
            "icon_name": icon,
            "names": names,
            "desktop_ids": desktop_ids,
            "action": "retain_previous" if prior else "unresolved",
            "reason": "source_unavailable",
        })

    # ------------------------------------------------------------------ sync
    def sync(self, apply: bool = False, activate: bool = False,
             state_changes: dict[Path, bytes] | None = None,
             activate_if_theme: str | None = None) -> dict[str, Any]:
        recovered = self.recover() if apply else False
        result = self.inspect()
        if not apply:
            return result.payload
        if state_changes:
            allowed_metadata = {self.state_dir / "config.json", self.state_dir / "baseline.json"}
            if not set(state_changes) <= allowed_metadata:
                raise ValueError("Theme migration metadata is outside its whitelist")
            result.changes.update(state_changes)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        baseline_path = self.state_dir / "baseline.json"
        if not baseline_path.exists() and baseline_path not in result.changes:
            baseline = {
                "icon_theme": gsettings.current_icon_theme(self.config.settings) or self.base_theme,
                "config": {
                    "policy": self.config.policy.to_dict(),
                    "theme_name": self.theme_name,
                    "theme_dir": str(self.theme_dir),
                    "state_dir": str(self.state_dir),
                    "user_applications": str(self.apps_dir),
                    "desktop": self.config.desktop,
                },
            }
            result.changes[baseline_path] = json.dumps(baseline, ensure_ascii=False, indent=2).encode()
        manifest_bytes = json.dumps(result.manifest, ensure_ascii=False, indent=2).encode()
        opcount, _changed = self.store.commit(
            result.changes, committed_last=(self.state_dir / "manifest.json", manifest_bytes)
        )
        if activate and self.config.settings and (activate_if_theme is None or
                gsettings.current_icon_theme(self.config.settings) in (activate_if_theme, self.theme_name)):
            pending = self.state_dir / "settings-pending.json"
            atomic_write(
                pending,
                json.dumps({"stage": "files_committed", "activate_theme": self.theme_name,
                            **({"only_if_current_theme": activate_if_theme} if activate_if_theme else {})}).encode(),
                0o600,
            )
            gsettings.finish_pending_theme(self.config.settings, pending, self.state_dir / "manifest.json")
        payload = result.payload
        payload["applied"] = True
        payload["recovered_transaction"] = recovered
        payload["file_operations"] = opcount
        payload["summary"]["cache_valid"] = self.cache_valid()
        payload["summary"]["active_theme"] = gsettings.current_icon_theme(self.config.settings)
        atomic_write(
            self.state_dir / "last-run.json",
            json.dumps({**payload, "checked_at_unix": time.time()}, ensure_ascii=False, indent=2).encode(),
            0o600,
        )
        return payload

    # ------------------------------------------------------------------ revert
    def revert(self) -> dict[str, Any]:
        self.recover()
        old = self.manifest()
        self.themedir.owned()
        changes: dict[Path, bytes | None] = {}
        conflicts: list[str] = []
        for target_str, record in old.get("desktop_overrides", {}).items():
            target = Path(target_str)
            if not target.exists():
                continue
            current = target.read_bytes()
            if sha_hex(current) == record["output_sha256"]:
                changes[target] = (
                    base64.b64decode(record["original_data"])
                    if record["original_existed"]
                    else None
                )
            elif read_desktop_section(current).get("Icon") == record["output_icon"]:
                changes[target] = rewrite_icon_line(current, record["source_icon"])
            else:
                conflicts.append(str(target))
        for item in old.get("items", {}).values():
            for p, digest in item.get("files", {}).items():
                target = Path(p)
                if not target.exists():
                    continue
                if sha_hex(target.read_bytes()) == digest:
                    changes[target] = None
                else:
                    conflicts.append(p)
        if conflicts:
            raise RuntimeError(
                "Rollback preserves external edits; review conflicts first: "
                + json.dumps(conflicts)
            )
        previous = gsettings.current_icon_theme(self.config.settings)
        baseline_path = self.state_dir / "baseline.json"
        baseline = json.loads(baseline_path.read_text()) if baseline_path.exists() \
            else {"icon_theme": previous or self.base_theme}
        manifest_path = self.state_dir / "manifest.json"
        manifest_bytes = self.revert_manifest_bytes()
        pending = self.state_dir / "settings-pending.json"
        change_theme = self.config.settings is not None and previous == self.theme_name
        if change_theme:
            atomic_write(pending, json.dumps({
                "stage": "revert_prepared", "previous_theme": previous,
                "restore_theme": str(baseline["icon_theme"]),
                "manifest_before_sha": sha_hex(manifest_path.read_bytes())
                    if manifest_path.exists() else None,
                "manifest_after_sha": sha_hex(manifest_bytes),
            }).encode(), 0o600)
        try:
            if change_theme:
                assert self.config.settings is not None
                gsettings.set_icon_theme(self.config.settings, str(baseline["icon_theme"]))
            self.store.commit(changes, committed_last=(manifest_path, manifest_bytes))
        except Exception:
            # If file recovery itself failed, leave both journals for the next
            # locked control invocation; never restore triggers over that state.
            if change_theme and not self.store.journal_path.exists():
                gsettings.finish_pending_theme(self.config.settings, pending, manifest_path)
            raise
        if change_theme:
            gsettings.finish_pending_theme(self.config.settings, pending, manifest_path)
        return {
            "ok": True,
            "reverted": True,
            "restored_theme": gsettings.current_icon_theme(self.config.settings)
            or baseline["icon_theme"],
            "removed_managed_files": len(changes),
        }

    def revert_manifest_bytes(self) -> bytes:
        new = {
            "version": MANIFEST_VERSION,
            "base_theme": self.base_theme,
            "items": {},
            "desktop_overrides": {},
        }
        return json.dumps(new, ensure_ascii=False, indent=2).encode()
