// SPDX-License-Identifier: GPL-3.0-or-later
import {RequestScope} from '../shared/backendClient.js';

// Each preferences component owns its requests and detaches from the parent
// on close. Cancellation stops reads and continuations, never a running write.
export class WindowScope extends RequestScope {
    constructor(window) {
        super();
        const id = window.connect('close-request', () => {
            this.close();
            return false;
        });
        this.cleanup(() => window.disconnect(id));
    }

}
