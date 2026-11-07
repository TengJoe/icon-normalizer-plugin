// Dump the engine-agnostic policy fingerprint for a strategy JSON, for the
// Python parity harness. usage: gjs -m tests/gjs/dump-fingerprint.js '<json>'
// SPDX-License-Identifier: GPL-3.0-or-later

import {policyFingerprint} from '../../extension/lib/engine/engine.js';

print(policyFingerprint(JSON.parse(ARGV[0])));
