#!/usr/bin/env python3
"""Build artifacts: extension ZIP + full release tarball (ADR-0004 §5).

``glib-compile-schemas --strict`` is a hard gate before packaging; the version
comes solely from ``extension/metadata.json``.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from layout import PACKAGE_EXCLUDE, PACKAGE_MEMBERS, backend_version
from release_audit import inspect_source, inspect_archive, inspect_tarball

PROJECT = Path(__file__).resolve().parent.parent
DIST = PROJECT / "dist"
UUID = "icon-normalizer@joeydeng.local"
BACKEND_VERSION = backend_version()


def version() -> str:
    metadata = json.loads((PROJECT / "extension" / "metadata.json").read_text())
    return str(metadata["version-name"])


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compile_schemas() -> None:
    binary = shutil.which("glib-compile-schemas")
    if binary is None:
        raise SystemExit("glib-compile-schemas not found; install libglib2.0-dev-bin")
    result = subprocess.run(
        [binary, "--strict", str(PROJECT / "extension" / "schemas")],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"schema compilation failed:\n{result.stderr}")


def build_zip(target: Path) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((PROJECT / "extension").rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            name = path.relative_to(PROJECT / "extension").as_posix()
            if name in PACKAGE_EXCLUDE:
                continue
            archive.write(path, name)


def build_tarball(target: Path, ver: str) -> None:
    import tarfile

    def public_member(item: tarfile.TarInfo) -> tarfile.TarInfo | None:
        if "__pycache__" in Path(item.name).parts or item.name.endswith(".pyc"):
            return None
        # Local account names and numeric IDs are irrelevant to installation.
        # Do not disclose them through tar headers or extended PAX metadata.
        item.uid = item.gid = 0
        item.uname = item.gname = ""
        for key in ("uid", "gid", "uname", "gname"):
            item.pax_headers.pop(key, None)
        return item

    with tarfile.open(target, "w:gz") as tar:
        for name in PACKAGE_MEMBERS:
            path = PROJECT / name
            if path.exists():
                tar.add(path, arcname=f"icon-normalizer-plugin/{name}", filter=public_member)


def build(staging: Path) -> dict[str, Any]:
    ver = version()
    compile_schemas()
    audit = inspect_source()
    if not audit["ok"]:
        raise SystemExit(json.dumps(audit, ensure_ascii=False, indent=2))

    zip_path = staging / f"{UUID}.zip"
    build_zip(zip_path)
    tar_path = staging / f"icon-normalizer-plugin-{ver}.tar.gz"
    build_tarball(tar_path, ver)
    if not (inspect_archive(zip_path)['matches_source'] and inspect_tarball(tar_path)['matches_source']):
        raise SystemExit('Built archives differ from current source; existing dist retained')

    manifest: dict[str, Any] = {
        "version": ver,
        "backend_version": BACKEND_VERSION,
        "release_warnings": audit["warnings"],
        "extension_zip": zip_path.name,
        "extension_zip_sha256": sha256_file(zip_path),
        "full_package": tar_path.name,
        "full_package_sha256": sha256_file(tar_path),
        "shell_versions": json.loads(
            (PROJECT / "extension" / "metadata.json").read_text())["shell-version"],
    }
    (staging / "DIST_MANIFEST.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> int:
    # Preserve the previous artifacts until both new archives pass byte parity.
    with tempfile.TemporaryDirectory(prefix='.icon-build-', dir=PROJECT) as temporary:
        staging = Path(temporary)
        manifest = build(staging)
        DIST.mkdir(exist_ok=True)
        names = {path.name for path in staging.iterdir()}
        for path in staging.iterdir():
            path.replace(DIST / path.name)
        for old in DIST.iterdir():
            if old.is_file() and old.name not in names:
                old.unlink()
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
