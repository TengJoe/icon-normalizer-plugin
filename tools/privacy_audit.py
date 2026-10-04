#!/usr/bin/env python3
"""Scan public source/artifacts without printing credential or contact values.

This conservative local check complements manual review; it cannot prove that
arbitrary secrets are absent. Paths are reported, matched content never is.
The extension UUID is a public upgrade identifier and is intentionally allowed.
"""
from __future__ import annotations
import argparse
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
PUBLIC_DIRS = ('backend', 'extension', 'tools', 'contracts', 'docs', 'packaging', 'tests')
PUBLIC_FILES = ('README.md', 'README.en.md', 'CHANGELOG.md', 'ARCHITECTURE.md',
                'PROTOCOL.md', 'pyproject.toml', 'LICENSE', '.gitignore')
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

def scan_text(contents: bytes) -> str:
    if contents.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff')):
        # Compressed pixel bytes can resemble tokens or emails by chance.
        # Inspect readable metadata; visual content still needs manual review.
        from PIL import Image
        with Image.open(BytesIO(contents)) as image:
            metadata = {key: value for key, value in image.info.items()
                        if key not in ('icc_profile', 'exif')}
            exif = image.getexif()
            metadata['exif_fields'] = dict(exif)
            for tag in (0x8769, 0x8825):
                if tag in exif:
                    metadata[f'exif_ifd_{tag}'] = exif.get_ifd(tag)
            return repr(metadata)
    return contents.decode('utf-8', errors='ignore')

def inspect(root: Path, archives: list[Path]) -> dict:
    uuid = json.loads((root / 'extension/metadata.json').read_text())['uuid']
    findings: list[dict] = []
    checked = 0
    def check(name: str, contents: bytes) -> None:
        nonlocal checked
        checked += 1
        parts = PurePosixPath(name).parts
        basename = PurePosixPath(name).name
        if any(part in LOCAL_COMPONENTS for part in parts) or PurePosixPath(name).suffix in PRIVATE_SUFFIXES or basename.startswith('.env'):
            findings.append({'file': name, 'category': 'local_or_credential_file'})
        text = scan_text(contents)
        for category, pattern in PATTERNS.items():
            matches = list(pattern.finditer(text))
            if category == 'email':
                matches = [match for match in matches if match.group().rstrip('.') not in (uuid, uuid + '.zip')
                           and not match.group().endswith(('@users.noreply.github.com', '@fixture.local'))]
            if matches:
                findings.append({'file': name, 'category': category, 'count': len(matches)})
    for part in [*PUBLIC_DIRS, *PUBLIC_FILES]:
        path = root / part
        if not path.exists(): continue
        files = sorted(path.rglob('*')) if path.is_dir() else [path]
        for item in files:
            if not item.is_file() or any(component in LOCAL_COMPONENTS for component in item.relative_to(root).parts):
                continue
            if item.is_symlink():
                findings.append({'file': str(item.relative_to(root)), 'category': 'symlink'})
                continue
            check(str(item.relative_to(root)), item.read_bytes())
    for archive in archives:
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as bundle:
                for name in bundle.namelist():
                    if not name.endswith('/'):check(f'{archive.name}/{name}', bundle.read(name))
        else:
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    name = f'{archive.name}/{member.name}'
                    if member.uid or member.gid or member.uname or member.gname or any(
                            key in member.pax_headers for key in ('uid','gid','uname','gname')):
                        findings.append({'file': name, 'category': 'archive_account_metadata'})
                    if member.issym() or member.islnk():
                        findings.append({'file': name, 'category': 'archive_symlink'})
                    if member.isfile():
                        stream = bundle.extractfile(member)
                        if stream is not None:check(name, stream.read())
    return {'ok': not findings, 'checked_files_and_members': checked, 'findings': findings,
            'public_identifier_retained': uuid,
            'exclusions': 'Caches, runtime state, logs and local screenshots are not part of the export allowlist.',
            'limitations': 'Pattern scan, image-metadata and account-header checks complement manual visual review; they cannot prove all secrets absent.'}

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=PROJECT)
    parser.add_argument('--archive', type=Path, action='append', default=[])
    args = parser.parse_args()
    result = inspect(args.root, args.archive)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 2

if __name__ == '__main__':raise SystemExit(main())
