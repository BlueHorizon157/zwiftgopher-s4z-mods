// The storage every module of the mod uses (shared-storage.mjs): its own shared keys where
// Sauce's windows don't hear them, everything else in Sauce's storage.
import * as common from '/pages/src/common.mjs';
import {createModStorage} from './shared-storage.mjs';

export const storage = common.storage
    ? createModStorage({local: window.localStorage, win: window, sauce: common.storage})
    : null;
