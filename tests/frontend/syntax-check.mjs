#!/usr/bin/env node
// Syntax gate: node --check over every extension JS module.
// Project root is derived from this file's location (no hardcoded paths).
import {spawnSync} from 'node:child_process';
import {readdirSync, statSync, readFileSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const frontendDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(frontendDir, '..', '..', 'extension');

function collectJs(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            if (entry === '__pycache__' || entry === 'schemas') continue;
            found.push(...collectJs(path));
        } else if (entry.endsWith('.js')) {
            found.push(path);
        }
    }
    return found;
}

const files = collectJs(extensionDir);
let failures = 0;
for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
        if (!existsSync(resolve(dirname(file), match[1]))) {
            failures += 1;
            console.error(`FAIL ${relative(extensionDir, file)} missing import ${match[1]}`);
        }
    }
    const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
    const rel = relative(extensionDir, file);
    if (result.status !== 0) {
        failures += 1;
        console.error(`FAIL ${rel}\n${result.stderr}`);
    } else {
        console.log(`ok   ${rel}`);
    }
}

// St compatibility lint: extension/stylesheet.css is parsed by BOTH the Shell's
// St/libcroco theme parser and GTK4/Adw. The Shell parser rejects GTK3-style
// alpha() functions, CSS variables and outline — mirror the official shell
// theme's syntax subset (rgba()/hex literals, border only). This is only a
// fast lint; test_runtime.py exercises the real St.Theme parser as well.
{
    const cssPath = join(extensionDir, 'stylesheet.css');
    if (existsSync(cssPath)) {
        const css = readFileSync(cssPath, 'utf8');
        const forbidden = [
            [/alpha\(/, 'alpha() color function (use rgba literals)'],
            [/\bcolor\s*:\s*@/, 'CSS variable reference in color (use literals)'],
            [/(^|[^-])outline\s*:/, 'outline property (use border)'],
        ];
        for (const [pattern, reason] of forbidden) {
            if (pattern.test(css)) {
                failures += 1;
                console.error(`FAIL stylesheet.css: ${reason}`);
            }
        }
        if (!failures) console.log('ok   stylesheet.css (quick lint; real St parser is Q8)');
    }
}

if (files.length === 0) {
    console.error('no JS files found — check extension dir');
    process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
