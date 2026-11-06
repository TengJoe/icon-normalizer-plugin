// Unit tests for theme generation and the transaction journal.
// Run: gjs -m tests/gjs/transaction.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {themeIndex} from '../../extension/lib/engine/theme.js';
import {
    TransactionStore, TransactionError, atomicWrite, readBytes, shaHex,
} from '../../extension/lib/engine/transaction.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

function tempDir() {
    return GLib.dir_make_tmp('icon-normalizer-test-XXXXXX');
}

function cleanup(path) {
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null)) return;
    const children = dir.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null)) !== null) {
        const child = dir.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY) cleanup(child.get_path());
        else child.delete(null);
    }
    dir.delete(null);
}

test('themeIndex matches the Python reference byte for byte', () => {
    const expected = '[Icon Theme]\nName=DockNormalized\n'
        + 'Comment=Normalized application artwork; original theme fallback\n'
        + 'Inherits=Yaru,hicolor\n'
        + 'Directories=16x16/apps,32x32/apps\n'
        + '\n[16x16/apps]\nSize=16\nType=Fixed\nContext=Applications\n'
        + '\n[32x32/apps]\nSize=32\nType=Fixed\nContext=Applications\n';
    assertEqual(themeIndex('DockNormalized', 'Yaru', [16, 32]), expected, 'index.theme');
});

test('shaHex hashes bytes and strings identically', () => {
    const encoder = new TextEncoder();
    assertEqual(shaHex(encoder.encode('abc')), shaHex('abc'), 'bytes vs string');
    assertEqual(shaHex('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'known digest');
    assertEqual(shaHex(null), null, 'missing file');
});

test('atomicWrite round-trips and creates parent directories', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'a', 'b', 'file.txt']);
        atomicWrite(path, new TextEncoder().encode('hello'));
        assertEqual(new TextDecoder().decode(readBytes(path)), 'hello', 'content');
    } finally {
        cleanup(root);
    }
});

test('commit applies writes and deletions inside protected roots', () => {
    const root = tempDir();
    try {
        const kept = GLib.build_filenamev([root, 'kept.txt']);
        const gone = GLib.build_filenamev([root, 'gone.txt']);
        atomicWrite(gone, new TextEncoder().encode('old'));
        const store = new TransactionStore(
            GLib.build_filenamev([root, 'journal.json']),
            [{path: root, fileMode: 0o644}]);
        const result = store.commit(new Map([
            [kept, new TextEncoder().encode('new')],
            [gone, null],
        ]));
        assertEqual(result.operations, 2, 'operations');
        assertEqual(new TextDecoder().decode(readBytes(kept)), 'new', 'written');
        assertTrue(readBytes(gone) === null, 'deleted');
        assertTrue(readBytes(GLib.build_filenamev([root, 'journal.json'])) === null,
            'journal removed');
    } finally {
        cleanup(root);
    }
});

test('commit skips files whose bytes already match', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'same.txt']);
        atomicWrite(path, new TextEncoder().encode('same'));
        const store = new TransactionStore(
            GLib.build_filenamev([root, 'journal.json']),
            [{path: root, fileMode: 0o644}]);
        const result = store.commit(new Map([[path, new TextEncoder().encode('same')]]));
        assertEqual(result.operations, 0, 'no work to do');
    } finally {
        cleanup(root);
    }
});

test('commit refuses paths outside every protected root', () => {
    const root = tempDir();
    try {
        const store = new TransactionStore(
            GLib.build_filenamev([root, 'journal.json']),
            [{path: root, fileMode: 0o644}]);
        let threw = false;
        try {
            store.commit(new Map([['/tmp/outside-icon-normalizer.txt',
                new TextEncoder().encode('x')]]));
        } catch {
            threw = true;
        }
        assertTrue(threw, 'rejects unmanaged path');
    } finally {
        cleanup(root);
    }
});

test('commit aborts when a guarded file changed since inspection', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'guarded.txt']);
        atomicWrite(path, new TextEncoder().encode('before'));
        const stale = shaHex('something-else');
        const store = new TransactionStore(
            GLib.build_filenamev([root, 'journal.json']),
            [{path: root, fileMode: 0o644}]);
        let threw = false;
        try {
            store.commit(new Map([[path, new TextEncoder().encode('after')]]),
                {expectedBefore: new Map([[path, stale]])});
        } catch (error) {
            threw = error instanceof TransactionError;
        }
        assertTrue(threw, 'conflict detected');
        assertEqual(new TextDecoder().decode(readBytes(path)), 'before', 'untouched');
    } finally {
        cleanup(root);
    }
});

test('recover restores the previous bytes from the journal', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'target.txt']);
        const journalPath = GLib.build_filenamev([root, 'journal.json']);
        atomicWrite(path, new TextEncoder().encode('broken'));
        const before = new TextEncoder().encode('original');
        const journal = {ops: [{
            path,
            before: GLib.base64_encode(before),
            before_sha: shaHex(before),
            after_sha: shaHex('broken'),
        }]};
        atomicWrite(journalPath, new TextEncoder().encode(JSON.stringify(journal)), 0o600);
        const store = new TransactionStore(journalPath, [{path: root, fileMode: 0o644}]);
        assertTrue(store.recover(), 'repaired');
        assertEqual(new TextDecoder().decode(readBytes(path)), 'original', 'restored');
        assertTrue(readBytes(journalPath) === null, 'journal cleared');
    } finally {
        cleanup(root);
    }
});

report();
