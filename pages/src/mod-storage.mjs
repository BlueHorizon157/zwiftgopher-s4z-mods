// The storage every module of the mod uses (shared-storage.mjs): its own shared keys where
// Sauce's windows don't hear them, everything else in Sauce's storage. A replay window
// (?replay=) gets a copy of the shared keys in memory instead, so nothing it does reaches the
// real windows: its plans, its controls, the plan it puts away or arms stay in the window.
import * as common from '/pages/src/common.mjs';
import {createModStorage, scratchLocal, readOnlyStorage} from './shared-storage.mjs';

const replaying = Boolean(new URLSearchParams(window.location.search).get('replay'));

export const storage = !common.storage ? null
    : replaying ? createModStorage({local: scratchLocal(window.localStorage), win: null, sauce: readOnlyStorage(common.storage)})
        : createModStorage({local: window.localStorage, win: window, sauce: common.storage});
