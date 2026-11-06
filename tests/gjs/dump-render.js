// Render fixtures for the Python parity harness.
// usage: gjs -m tests/gjs/dump-render.js jobfile.json
//   jobfile: {outdir, jobs: [{path, cls, sizes, target, inner}]}
// Writes <outdir>/<jobIndex>-<size>.png and prints a JSON summary.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {analyze} from '../../extension/lib/engine/analyze.js';
import {loadPixbuf} from '../../extension/lib/engine/load.js';
import {normalize} from '../../extension/lib/engine/render.js';

const [jobPath] = ARGV;
const [, bytes] = Gio.File.new_for_path(jobPath).load_contents(null);
const job = JSON.parse(new TextDecoder().decode(bytes));
const results = [];

job.jobs.forEach((entry, index) => {
    const row = {index, path: entry.path, cls: entry.cls, ok: true, renders: []};
    try {
        const source = loadPixbuf(entry.path);
        const metrics = analyze(source);
        for (const size of entry.sizes) {
            const {pixbuf, info} = normalize(source, metrics, entry.cls, {
                size,
                target: entry.target,
                inner: entry.inner,
            });
            const file = GLib.build_filenamev([job.outdir, index + "-" + size + ".png"]);
            pixbuf.savev(file, 'png', [], []);
            row.renders.push({size, info});
        }
    } catch (error) {
        row.ok = false;
        row.error = String(error && error.message || error);
    }
    results.push(row);
});

print(JSON.stringify(results));
