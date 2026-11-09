#!/usr/bin/env python3
"""Scan every tracked file and released artifact for credentials and contacts.

The scan is deny-by-default: it walks *everything Git tracks* (plus the
archive members of the release artifacts) instead of a hand-maintained list of
directories, so a new top-level file or folder cannot silently escape review.
Anything benign that the patterns still flag must be added to
tools/privacy-allowlist.txt with a reason; that file is the only exception
mechanism and it is reviewed like any other source.

Paths are reported, matched content never is. The extension UUID is a public
upgrade identifier and is intentionally allowed.
"""
from __future__ import annotations
import argparse
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
ALLOWLIST = Path(__file__).resolve().with_name("privacy-allowlist.txt")
PATTERNS = {
    'private_key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'),
    'github_token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b'),
    'cloud_access_key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'provider_token': re.compile(r'\b(?:sk-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,})\b'),
    'credential_url': re.compile(r'https?://[^\s/"\x27]+:[^\s/"\x27]+@'),
    'personal_home': re.compile(r'(?:/' + 'home/' + r'(?!test(?:/|["\x27\s]|$)|user(?:/|["\x27\s]|$))[^/\s"\x27]+|/' + 'Users/' + r'[^/\s"\x27]+)'),
    'email': re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
}
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.log'}
LOCAL_COMPONENTS = {'__pycache__', '.mypy_cache', '.pytest_cache', '.venv', 'work',
                    'outputs', 'evidence', 'screenshots', 'backups', '.git'}


def load_allowlist() -> dict[str, str]:
    """Reviewed exceptions: "<path>\t<category>\t<reason>" per line."""
    entries: dict[str, str] = {}
    if not ALLOWLIST.exists():
        return entries
    for number, raw in enumerate(ALLOWLIST.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 3 or not parts[2].strip():
            raise SystemExit(f"privacy-allowlist.txt:{number}: expected path<TAB>category<TAB>reason")
        entries[f"{parts[0]}\t{parts[1]}"] = parts[2].strip()
    return entries


def tracked_files(root: Path) -> list[Path]:
    """Every file Git tracks; falls back to a walk outside a checkout."""
    try:
        listed = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                                capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return sorted(p for p in root.rglob("*") if p.is_file()
                      and not any(part in LOCAL_COMPONENTS for part in p.relative_to(root).parts))
    names = [name for name in listed.decode().split("\0") if name]
    return [root / name for name in sorted(names)]


def scan_text(contents: bytes) -> str:
    if contents.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")):
        # Compressed pixel bytes can resemble tokens or emails by chance.
        # Inspect readable metadata; visual content still needs manual review.
        from PIL import Image
        with Image.open(BytesIO(contents)) as image:
            metadata = {key: value for key, value in image.info.items()
                        if key not in ("icc_profile", "exif")}
            exif = image.getexif()
            metadata["exif_fields"] = dict(exif)
            for tag in (0x8769, 0x8825):
                if tag in exif:
                    metadata[f"exif_ifd_{tag}"] = exif.get_ifd(tag)
            return repr(metadata)
    return contents.decode("utf-8", errors="ignore")


def inspect(root: Path, archives: list[Path]) -> dict:
    uuid = json.loads((root / "extension/metadata.json").read_text())["uuid"]
    allowlist = load_allowlist()
    findings: list[dict] = []
    allowed: list[dict] = []
    checked = 0

    def check(name: str, contents: bytes) -> None:
        nonlocal checked
        checked += 1
        parts = PurePosixPath(name).parts
        basename = PurePosixPath(name).name
        categories: list[str] = []
        if any(part in LOCAL_COMPONENTS for part in parts) \
                or PurePosixPath(name).suffix in PRIVATE_SUFFIXES \
                or basename.startswith(".env"):
            categories.append("local_or_credential_file")
        text = scan_text(contents)
        for category, pattern in PATTERNS.items():
            matches = list(pattern.finditer(text))
            if category == "email":
                matches = [match for match in matches
                           if match.group().rstrip(".") not in (uuid, uuid + ".zip")
                           and not match.group().endswith(("@users.noreply.github.com",
                                                          "@fixture.local"))]
            if matches:
                categories.append(category)
        for category in categories:
            reason = allowlist.get(f"{name}\t{category}")
            if reason:
                allowed.append({"file": name, "category": category, "reason": reason})
            else:
                findings.append({"file": name, "category": category})

    for item in tracked_files(root):
        if not item.is_file():
            continue
        if item.is_symlink():
            findings.append({"file": str(item.relative_to(root)), "category": "symlink"})
            continue
        check(str(item.relative_to(root)), item.read_bytes())
    for archive in archives:
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as bundle:
                for name in bundle.namelist():
                    if not name.endswith("/"):
                        check(f"{archive.name}/{name}", bundle.read(name))
        else:
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    name = f"{archive.name}/{member.name}"
                    if member.uid or member.gid or member.uname or member.gname or any(
                            key in member.pax_headers for key in ("uid", "gid", "uname", "gname")):
                        findings.append({"file": name, "category": "archive_account_metadata"})
                    if member.issym() or member.islnk():
                        findings.append({"file": name, "category": "archive_symlink"})
                    if member.isfile():
                        stream = bundle.extractfile(member)
                        if stream is not None:
                            check(name, stream.read())
    unused = sorted(set(allowlist) - {f"{entry['file']}\t{entry['category']}" for entry in allowed})
    return {
        "ok": not findings,
        "scope": "every file tracked by git, plus release archive members",
        "checked_files_and_members": checked,
        "allowlisted": allowed,
        "stale_allowlist_entries": unused,
        "findings": findings,
        "public_identifier_retained": uuid,
        "limitations": "Pattern, image-metadata and archive-header checks complement "
                       "manual review; they cannot prove all secrets absent.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=PROJECT)
    parser.add_argument("--archive", type=Path, action="append", default=[])
    args = parser.parse_args()
    result = inspect(args.root, args.archive)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
