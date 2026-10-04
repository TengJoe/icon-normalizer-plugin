#!/usr/bin/env python3
"""Mechanical release gates; --submission also requires the real project URL.

This does not predict GNOME Extensions review approval. It checks the package,
entry-point isolation and declared support; runtime acceptance is separate.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlparse
import zipfile

PROJECT = Path(__file__).resolve().parent.parent
EXTENSION = PROJECT / 'extension'
TESTED_SHELL = {'51'}
ALLOWED_SUFFIXES = {'.js', '.json', '.xml', '.compiled', '.css', '.svg'}
IMPORT = re.compile(r"\bimport\s+(?:[\w{},*\s]+?\s+from\s+)?['\"]([^'\"]+)['\"]")


def reachable(entry: Path) -> set[Path]:
    pending = [entry]; result: set[Path] = set()
    while pending:
        path = pending.pop()
        if path in result: continue
        result.add(path)
        for specifier in IMPORT.findall(path.read_text()):
            if specifier.startswith('.'):
                child = (path.parent/specifier).resolve()
                if not child.is_relative_to(EXTENSION.resolve()) or not child.is_file():
                    raise ValueError(f'Unresolved or escaping import: {path.name}: {specifier}')
                pending.append(child)
    return result


def inspect_source(submission: bool = False) -> dict:
    checks = []; warnings = []
    def check(name, ok, detail=''):
        checks.append({'check': name, 'passed': bool(ok), 'detail': detail})
    metadata = json.loads((EXTENSION/'metadata.json').read_text())
    check('metadata_identity', metadata.get('uuid') == 'icon-normalizer@joeydeng.local' and
          metadata.get('settings-schema') == 'org.gnome.shell.extensions.icon-normalizer')
    check('version_name', bool(re.fullmatch(r'\d+\.\d+\.\d+', metadata.get('version-name', ''))))
    check('tested_shell_versions', bool(metadata.get('shell-version')) and
          set(metadata['shell-version']) <= TESTED_SHELL, 'Runtime evidence exists for GNOME 51.')
    for entry, forbidden in [('extension.js', ('gi://Gtk', 'gi://Gdk', 'gi://Adw')),
                              ('prefs.js', ('gi://St', 'gi://Clutter', '/shell/ui/'))]:
        try:
            closure = reachable(EXTENSION/entry)
            hits = [p.relative_to(EXTENSION).as_posix() for p in closure
                    if any(value in p.read_text() for value in forbidden)]
            check(f'{entry}_toolkit_isolation', not hits, ', '.join(hits))
        except (OSError, ValueError) as exc:
            check(f'{entry}_toolkit_isolation', False, str(exc))
    check('gpl_license', (PROJECT/'LICENSE').is_file() and (EXTENSION/'LICENSE').is_file() and
          (PROJECT/'LICENSE').read_bytes() == (EXTENSION/'LICENSE').read_bytes())
    files = [p for p in EXTENSION.rglob('*') if p.is_file()]
    unexpected = [str(p.relative_to(EXTENSION)) for p in files
                  if p.name != 'LICENSE' and p.suffix not in ALLOWED_SUFFIXES]
    check('extension_source_only', not unexpected, ', '.join(unexpected))
    check('no_extension_symlinks', not any(p.is_symlink() for p in EXTENSION.rglob('*')))
    check('strict_schema_compiled', (EXTENSION/'schemas/gschemas.compiled').is_file())
    check('english_and_chinese_docs', all((PROJECT/p).is_file() for p in ['README.md','README.en.md']))
    check('companion_review_notes', (PROJECT/'docs/SUBMISSION.md').is_file())
    url = metadata.get('url', '')
    parsed = urlparse(url)
    real_url = parsed.scheme == 'https' and bool(parsed.netloc) and parsed.path not in ('', '/') and not any(
        token in parsed.netloc for token in ['example.', '.invalid', 'localhost'])
    if submission: check('public_source_url', real_url, 'A real public source/issue tracker URL is needed.')
    elif not real_url: warnings.append('Public project URL is pending; --submission will fail until it is supplied.')
    return {'ok': all(c['passed'] for c in checks), 'submission_mode': submission,
            'checks': checks, 'warnings': warnings,
            'review': 'GNOME Extensions reviewer approval has not been requested.'}


def inspect_archive(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        expected = {str(p.relative_to(EXTENSION)): p.read_bytes()
                    for p in EXTENSION.rglob('*') if p.is_file()}
        members = archive.namelist()
        exact = set(members) == set(expected) and len(members) == len(set(members))
        matching = exact and all(archive.read(name) == data for name, data in expected.items())
        return {'archive': str(path), 'members': len(members), 'matches_source': matching}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--submission', action='store_true')
    parser.add_argument('--archive', type=Path)
    options = parser.parse_args(); result = inspect_source(options.submission)
    if options.archive:
        result['archive'] = inspect_archive(options.archive)
        result['ok'] = result['ok'] and result['archive']['matches_source']
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 2

if __name__ == '__main__': raise SystemExit(main())
