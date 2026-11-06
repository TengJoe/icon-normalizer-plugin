// Unit tests for icon resolution. Run: gjs -m tests/gjs/resolver.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {resolveSource, isInside, parseThemeIndex} from '../../extension/lib/engine/resolver.js';
import {atomicWrite} from '../../extension/lib/engine/transaction.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

function tempDir() {
    return GLib.dir_make_tmp('icon-normalizer-resolver-XXXXXX');
}

test('an absolute reference passes through unchanged', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'icon.png']);
        atomicWrite(path, new TextEncoder().encode('x'));
        assertEqual(resolveSource(path, null), path, 'absolute path');
    } finally {
        GLib.spawn_command_line_sync('rm -rf ' + root);
    }
});

test('a theme name goes through the injected resolver', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'themed.png']);
        atomicWrite(path, new TextEncoder().encode('x'));
        const resolver = {lookup: (name, size) => {
            assertEqual(name, 'example', 'name forwarded');
            assertEqual(size, 128, 'size forwarded');
            return path;
        }};
        assertEqual(resolveSource('example', resolver, {size: 128}), path, 'resolved');
    } finally {
        GLib.spawn_command_line_sync('rm -rf ' + root);
    }
});

test('a missing file is rejected', () => {
    let threw = false;
    try {
        resolveSource('/tmp/definitely-not-here-icon.png', null);
    } catch {
        threw = true;
    }
    assertTrue(threw, 'throws for a missing file');
});

test('artwork inside the generated overlay is rejected as a source', () => {
    const root = tempDir();
    try {
        const overlay = GLib.build_filenamev([root, 'overlay']);
        const inside = GLib.build_filenamev([overlay, 'apps', 'icon.png']);
        atomicWrite(inside, new TextEncoder().encode('x'));
        let threw = false;
        try {
            resolveSource(inside, null, {forbiddenDir: overlay});
        } catch {
            threw = true;
        }
        assertTrue(threw, 'overlay rejected');
    } finally {
        GLib.spawn_command_line_sync('rm -rf ' + root);
    }
});

test('isInside compares path prefixes, not raw strings', () => {
    assertTrue(isInside('/a/b/c.png', '/a/b'), 'inside');
    assertTrue(!isInside('/a/bc/c.png', '/a/b'), 'sibling prefix is not inside');
});

test('parseThemeIndex reads Inherits and Directories', () => {
    const root = tempDir();
    try {
        const path = GLib.build_filenamev([root, 'index.theme']);
        atomicWrite(path, new TextEncoder().encode(
            '[Icon Theme]\nInherits=Yaru,hicolor\nDirectories=16x16/apps,32x32/apps\n'));
        const parsed = parseThemeIndex(path);
        assertEqual(parsed.inherits.join(','), 'Yaru,hicolor', 'inherits');
        assertEqual(parsed.directories.join(','), '16x16/apps,32x32/apps', 'directories');
    } finally {
        GLib.spawn_command_line_sync('rm -rf ' + root);
    }
});

report();
