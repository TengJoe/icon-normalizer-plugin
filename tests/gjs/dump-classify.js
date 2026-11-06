// Dump classification results for the Python parity harness.
// usage: gjs -m tests/gjs/dump-classify.js jobfile.json
//   jobfile: {overrides, rules, items: [{icon, digest, metrics}]}
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

import {classifySourceEx} from '../../extension/lib/engine/classification.js';

const [jobPath] = ARGV;
const [, bytes] = Gio.File.new_for_path(jobPath).load_contents(null);
const job = JSON.parse(new TextDecoder().decode(bytes));
const out = job.items.map(item => {
    const result = classifySourceEx(item.icon, item.digest, item.metrics,
        job.overrides || {}, job.rules || {}, job.pathByKey || null);
    return {
        icon: item.icon,
        cls: result.result.cls,
        reason: result.result.reason,
        confidence: result.result.confidence,
        automatic: result.automatic,
        state: result.state,
        detail: result.detail,
    };
});
print(JSON.stringify(out));
