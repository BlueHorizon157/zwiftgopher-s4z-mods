// The storage every module uses: the mod's shared keys in localStorage (see shared-storage.mjs),
// everything else in Sauce's storage. A replay window (?replay=) gets an in-memory copy of the
// shared keys instead, so nothing it does reaches the real windows.
import * as common from '/pages/src/common.mjs';
import {createModStorage, scratchLocal, readOnlyStorage} from './shared-storage.mjs';

const replaying = Boolean(new URLSearchParams(window.location.search).get('replay'));

export const storage = !common.storage ? null
    : replaying ? createModStorage({local: scratchLocal(window.localStorage), win: null, sauce: readOnlyStorage(common.storage)})
        : createModStorage({local: window.localStorage, win: window, sauce: common.storage});
