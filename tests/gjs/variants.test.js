// Unit tests for light/dark and accent variant resolution.
// Mirrors backend tests for theme_follow.resolve_variant() so both engines agree.
// Run: gjs -m tests/gjs/variants.test.js
// SPDX-License-Identifier: GPL-3.0-or-later

import {
    parseThemeVariant, resolveVariant, resolveSystemVariant, YARU_ACCENTS,
} from '../../extension/lib/variants.js';
import {test, assertEqual, report} from './harness.js';

/** Installed-theme probe over a fixed set. */
const installed = names => name => names.includes(name);

test('parseThemeVariant recognises dark and light suffixes', () => {
    assertEqual(JSON.stringify(parseThemeVariant("Yaru-blue-dark")),
        '{"stem":"Yaru-blue","sep":"-","variant":"dark"}', "hyphen dark");
    assertEqual(JSON.stringify(parseThemeVariant("Papirus_Dark")),
        '{"stem":"Papirus","sep":"_","variant":"dark"}', "underscore dark");
    assertEqual(JSON.stringify(parseThemeVariant("Adwaita-black")),
        '{"stem":"Adwaita","sep":"-","variant":"dark"}', "black counts as dark");
    assertEqual(JSON.stringify(parseThemeVariant("Yaru-light")),
        '{"stem":"Yaru","sep":"-","variant":"light"}', "light");
    assertEqual(JSON.stringify(parseThemeVariant("Yaru")),
        '{"stem":"Yaru","sep":null,"variant":null}', "plain");
});

test('resolveVariant follows the sibling in the requested direction', () => {
    const set = installed(["Yaru", "Yaru-dark"]);
    assertEqual(resolveVariant("Yaru", true, set), "Yaru-dark", "light -> dark");
    assertEqual(resolveVariant("Yaru-dark", false, set), "Yaru", "dark -> light");
    assertEqual(resolveVariant("Yaru-dark", true, set), "Yaru-dark", "already dark");
    assertEqual(resolveVariant("Yaru", false, set), "Yaru", "already light");
});

test('resolveVariant never invents a theme that is not installed', () => {
    const only = installed(["Adwaita"]);
    assertEqual(resolveVariant("Adwaita", true, only), "Adwaita", "no sibling");
    assertEqual(resolveVariant("Yaru", true, installed([])), "Yaru", "nothing installed");
    assertEqual(resolveVariant("", true, only), "", "empty input");
});

test('Yaru accents map to the installed colour suffixes', () => {
    const set = installed(["Yaru", "Yaru-blue", "Yaru-blue-dark", "Yaru-olive",
        "Yaru-prussiangreen-dark"]);
    assertEqual(resolveSystemVariant("Yaru-blue", true, "blue", set), "Yaru-blue-dark",
        "blue dark");
    assertEqual(resolveSystemVariant("Yaru-blue-dark", false, "blue", set), "Yaru-blue",
        "blue light");
    assertEqual(resolveSystemVariant("Yaru", false, "green", set), "Yaru-olive",
        "green maps to olive");
    assertEqual(resolveSystemVariant("Yaru-blue", true, "teal", set),
        "Yaru-prussiangreen-dark", "teal maps to prussiangreen");
    assertEqual(resolveSystemVariant("Yaru-blue", true, "brown", set),
        "Yaru-blue-dark", "uninstalled accent keeps the current colour");
    assertEqual(YARU_ACCENTS.orange, "", "orange is the plain Yaru theme");
});

test('an accent request never leaves the Yaru family', () => {
    const set = installed(["Papirus", "Papirus-Dark", "Yaru", "Yaru-red", "Yaru-red-dark"]);
    assertEqual(resolveSystemVariant("Papirus", true, "red", set), "Papirus-Dark",
        "non-Yaru theme uses light/dark only");
});

report();
