"""Reject stale/incomplete archives and retain the previous dist on failure."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import build
import release_audit


class PackageParity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='icon-build-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, data in {
            'extension/metadata.json': json.dumps({'version-name': '1.1.5', 'shell-version': ['51']}),
            'extension/extension.js': "import './shell/themeSync.js';\n",
            'extension/shell/themeSync.js': 'export const sync = true;\n',
            'backend/control.py': 'print("fixture")\n',
            'README.md': 'fixture\n',
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for module, name, value in [(build, 'PROJECT', self.root), (build, 'DIST', self.root / 'dist'),
                                     (release_audit, 'PROJECT', self.root),
                                     (release_audit, 'EXTENSION', self.root / 'extension')]:
            self.stack.enter_context(patch.object(module, name, value))
        self.stack.enter_context(patch.object(build, 'compile_schemas'))
        self.stack.enter_context(patch.object(build, 'inspect_source', return_value={'ok': True, 'warnings': []}))

    def test_both_archives_detect_missing_helper_and_stale_source(self):
        archive = self.root / 'extension.zip'
        build.build_zip(archive)
        self.assertTrue(release_audit.inspect_archive(archive)['matches_source'])
        tar = self.root / 'source.tar.gz'
        build.build_tarball(tar, '1.1.5')
        self.assertTrue(release_audit.inspect_tarball(tar)['matches_source'])
        helper = self.root / 'extension/shell/themeSync.js'
        helper.write_text('export const sync = false;\n')
        self.assertFalse(release_audit.inspect_archive(archive)['matches_source'])
        self.assertFalse(release_audit.inspect_tarball(tar)['matches_source'])
        # Old archives can have valid metadata but omit a newly imported helper.
        with zipfile.ZipFile(archive, 'w') as package:
            package.write(self.root / 'extension/metadata.json', 'metadata.json')
        self.assertFalse(release_audit.inspect_archive(archive)['matches_source'])

    def test_failed_build_keeps_existing_dist(self):
        dist = self.root / 'dist'
        dist.mkdir()
        old = dist / 'old-package.zip'
        old.write_bytes(b'previous verified package')
        def empty_tar(target, version):
            with tarfile.open(target, 'w:gz'):
                pass
        with patch.object(build, 'build_tarball', side_effect=empty_tar), self.assertRaises(SystemExit):
            build.main()
        self.assertEqual(old.read_bytes(), b'previous verified package')
        self.assertEqual(list(dist.iterdir()), [old])

    def test_successful_build_includes_imported_helper_and_manifest(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build.main(), 0)
        dist = self.root / 'dist'
        manifest = json.loads((dist / 'DIST_MANIFEST.json').read_text())
        with zipfile.ZipFile(dist / manifest['extension_zip']) as package:
            self.assertIn('shell/themeSync.js', package.namelist())
        self.assertTrue(release_audit.inspect_tarball(dist / manifest['full_package'])['matches_source'])
        self.assertEqual(manifest['extension_zip_sha256'], build.sha256_file(dist / manifest['extension_zip']))
