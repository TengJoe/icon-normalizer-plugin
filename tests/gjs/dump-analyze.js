// Dump analyzer metrics for a list of files, for the Python parity harness.
// usage: gjs -m tests/gjs/dump-analyze.js path1 path2 ...
// SPDX-License-Identifier: GPL-3.0-or-later

import {analyze, classify, suggestClass} from '../../extension/lib/engine/analyze.js';
import {loadPixbuf} from '../../extension/lib/engine/load.js';

const out = [];
for (const path of ARGV) {
    try {
        const pb = loadPixbuf(path);
        const metrics = analyze(pb);
        out.push({
            path,
            ok: true,
            metrics,
            classification: classify(metrics),
            suggested: suggestClass(metrics),
        });
    } catch (error) {
        out.push({path, ok: false, error: String(error && error.message || error)});
    }
}
print(JSON.stringify(out));
