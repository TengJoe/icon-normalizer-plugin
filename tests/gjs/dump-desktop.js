// Dump desktop scanning results for the Python parity harness.
// usage: gjs -m tests/gjs/dump-desktop.js <desktop> <home>
// SPDX-License-Identifier: GPL-3.0-or-later

import {collectDesktopEntries} from '../../extension/lib/engine/desktop.js';

const [desktop, home] = ARGV;
const result = collectDesktopEntries(desktop, home);
print(JSON.stringify(result));
