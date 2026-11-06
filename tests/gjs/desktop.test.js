// Unit tests for desktop entry scanning. Run: gjs -m tests/gjs/desktop.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import {
    entryVisibility, readDesktopSection, rewriteIconLine, splitExec,
} from '../../extension/lib/engine/desktop.js';
import {test, assertEqual, assertTrue, report} from './harness.js';

const encoder = new TextEncoder();
const bytes = text => encoder.encode(text);

test('readDesktopSection keeps key case and ignores other sections', () => {
    const section = readDesktopSection(bytes([
        '[Desktop Entry]',
        'Name=Example',
        'Icon=example',
        'NoDisplay=false',
        '',
        '[Desktop Action New]',
        'Name=New Window',
        '',
    ].join('\n')));
    assertEqual(section.Name, 'Example', 'Name');
    assertEqual(section.Icon, 'example', 'Icon');
    assertEqual(section.NoDisplay, 'false', 'NoDisplay');
    assertTrue(section['Name'] !== 'New Window', 'action section ignored');
});

test('readDesktopSection tolerates a colon delimiter and comments', () => {
    const section = readDesktopSection(bytes([
        '# leading comment',
        '[Desktop Entry]',
        '; another comment',
        'Name:Example',
    ].join('\n')));
    assertEqual(section.Name, 'Example', 'colon delimiter');
});

test('rewriteIconLine replaces only the main Icon line', () => {
    const original = [
        '[Desktop Entry]',
        'Type=Application',
        'Icon=old',
        'Exec=example %U',
        '',
        '[Desktop Action New]',
        'Icon=old',
        '',
    ].join('\n');
    const out = rewriteIconLine(bytes(original), 'new-icon');
    const lines = out.split('\n');
    assertEqual(lines[2], 'Icon=new-icon', 'main Icon replaced');
    assertEqual(lines[6], 'Icon=old', 'action Icon untouched');
    assertEqual(lines[3], 'Exec=example %U', 'Exec untouched');
    assertEqual(lines[0], '[Desktop Entry]', 'header untouched');
});

test('rewriteIconLine preserves CRLF line endings', () => {
    const original = '[Desktop Entry]\r\nIcon=old\r\nExec=x\r\n';
    const out = rewriteIconLine(bytes(original), 'new');
    assertEqual(out, '[Desktop Entry]\r\nIcon=new\r\nExec=x\r\n', 'CRLF preserved');
});

test('rewriteIconLine refuses an entry with no main Icon', () => {
    let threw = false;
    try {
        rewriteIconLine(bytes('[Desktop Entry]\nName=NoIcon\n'), 'x');
    } catch {
        threw = true;
    }
    assertTrue(threw, 'throws');
});

test('rewriteIconLine refuses a newline inside the icon name', () => {
    let threw = false;
    try {
        rewriteIconLine(bytes('[Desktop Entry]\nIcon=old\n'), 'bad\nname');
    } catch {
        threw = true;
    }
    assertTrue(threw, 'throws');
});

test('splitExec handles quoting and escapes', () => {
    assertEqual(JSON.stringify(splitExec('example --flag')), '["example","--flag"]', 'plain');
    assertEqual(JSON.stringify(splitExec('example "two words"')), '["example","two words"]', 'double quotes');
    assertEqual(JSON.stringify(splitExec("example 'two words'")), '["example","two words"]', 'single quotes');
    assertEqual(JSON.stringify(splitExec('')), '[]', 'empty');
});

test('entryVisibility follows the freedesktop rules', () => {
    assertEqual(entryVisibility({Icon: 'x', Exec: 'sh'}, 'GNOME'), 'visible', 'plain');
    assertEqual(entryVisibility({Icon: 'x'}, 'GNOME'), 'exec_missing', 'no Exec');
    assertEqual(entryVisibility({Hidden: 'true'}, 'GNOME'), 'hidden', 'Hidden');
    assertEqual(entryVisibility({NoDisplay: 'true'}, 'GNOME'), 'no_display', 'NoDisplay');
    assertEqual(entryVisibility({OnlyShowIn: 'KDE;'}, 'GNOME'),
        'only_show_in_other_desktop', 'OnlyShowIn');
    assertEqual(entryVisibility({NotShowIn: 'GNOME;'}, 'GNOME'),
        'not_show_in_current_desktop', 'NotShowIn');
    assertEqual(entryVisibility({Exec: 'definitely-not-a-real-binary-xyz'}, 'GNOME'),
        'exec_missing', 'missing binary');
    assertEqual(entryVisibility({TryExec: 'definitely-not-a-real-binary-xyz', Exec: 'sh'}, 'GNOME'),
        'tryexec_missing', 'missing TryExec');
    assertEqual(entryVisibility({DBusActivatable: 'true'}, 'GNOME'), 'visible', 'D-Bus only');
});

report();
