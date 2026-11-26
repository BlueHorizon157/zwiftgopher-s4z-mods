// The state the mod's windows share (the plan library, the active plan, the controls, the
// planner link and shelf, the recorder, the update check, the live-state heartbeat), in the
// browser's localStorage under keys Sauce's windows leave alone.
//
// Sauce's storage (common.mjs LocalStorage) makes every key that starts with '/' global, and
// every Sauce window's settings store hears each write to a global key, from any window, as a
// change to its own settings: the Watching (grid) window reloads its page, Nearby and Groups
// redraw everything (Sauce pages/src/common.mjs SettingsStore, watching.mjs, nearby.mjs,
// groups.mjs, as of 2026-11). The mod writes its shared keys often enough (the shelf sync
// once a minute, heartbeats every couple of seconds) to make those windows flicker and reload.
//
// So the mod keeps them under '~zg-tt/' instead of '/zg-tt/'. Sauce's storage handler only
// looks at keys that start with '/' or with a window's own '<window id>-', and Sauce's window
// ids never start with '~', so no Sauce window wakes. The mod's windows hear each other through
// the browser's storage event, as 'globalupdate' with the key in its '/zg-tt/' form, so the
// callers keep their keys and listeners. Other keys go to Sauce's storage as before.
//
// A key not yet under '~zg-tt/' is read once from Sauce's storage and copied across (0.9.5 and
// earlier kept them there); Sauce's copy is left as it was, so nothing is written there. A mod
// key deleted here is kept as null, so the old copy never comes back.

export const MOD_PREFIX = '/zg-tt/';
export const LOCAL_PREFIX = '~zg-tt/';

const localKey = key => LOCAL_PREFIX + key.slice(MOD_PREFIX.length);

/**
 * A copy of the mod's keys in a localStorage, held in memory, as a localStorage itself: for a
 * replay window (?replay=), which reads what is there (the plans, the link) and writes only into
 * the copy, so a replay never changes the plans, the controls or the link the real windows share.
 */
export function scratchLocal(local) {
    const copy = new Map();
    for (let i = 0; i < (local?.length ?? 0); i++) {
        const key = local.key(i);
        if (typeof key === 'string' && key.startsWith(LOCAL_PREFIX)) {
            copy.set(key, local.getItem(key));
        }
    }
    return {
        getItem: key => (copy.has(key) ? copy.get(key) : null),
        setItem: (key, value) => copy.set(key, String(value)),
        removeItem: key => copy.delete(key),
    };
}

/** Sauce's storage as the mod's storage reads it, with no writes (for the replay window's other keys). */
export function readOnlyStorage(sauce) {
    return {
        get: (key, def) => sauce?.get(key, def),
        set() {},
        delete() {},
        addEventListener: (type, fn) => sauce?.addEventListener?.(type, fn),
        removeEventListener: (type, fn) => sauce?.removeEventListener?.(type, fn),
    };
}
const isMod = key => typeof key === 'string' && key.startsWith(MOD_PREFIX);

/**
 * local: a localStorage (getItem/setItem/removeItem); win: where 'storage' events arrive (a
 * window); sauce: Sauce's storage (common.storage) for every other key, and the old copies.
 */
export function createModStorage({local, win = null, sauce = null} = {}) {
    const listeners = new Set();
    const emit = (key, value) => {
        const ev = {type: 'globalupdate', data: {key, value}};
        for (const fn of listeners) {
            try {
                fn(ev);
            } catch (err) {
                console.error('[storage] listener', err);
            }
        }
    };
    win?.addEventListener?.('storage', ev => {
        if (typeof ev?.key !== 'string' || !ev.key.startsWith(LOCAL_PREFIX)) {
            return;
        }
        let value;
        try {
            value = ev.newValue == null ? undefined : JSON.parse(ev.newValue);
        } catch {
            return;
        }
        emit(MOD_PREFIX + ev.key.slice(LOCAL_PREFIX.length), value);
    });
    // Sauce's own global updates (keys outside the mod's) pass through to the same listeners.
    sauce?.addEventListener?.('globalupdate', ev => {
        if (!isMod(ev?.data?.key)) {
            for (const fn of listeners) {
                fn(ev);
            }
        }
    });

    const write = (key, value) => local.setItem(localKey(key), JSON.stringify(value === undefined ? null : value));

    return {
        get(key, def) {
            if (!isMod(key)) {
                return sauce?.get(key, def);
            }
            let raw = local?.getItem(localKey(key));
            if (raw == null && sauce) {
                const old = sauce.get(key);
                if (old !== undefined) {
                    write(key, old);
                    return old;
                }
            }
            if (raw == null) {
                return def;
            }
            try {
                return JSON.parse(raw);
            } catch {
                return def;
            }
        },
        set(key, value) {
            if (!isMod(key)) {
                return sauce?.set(key, value);
            }
            write(key, value);
        },
        delete(key) {
            if (!isMod(key)) {
                return sauce?.delete?.(key);
            }
            write(key, null);
        },
        addEventListener(type, fn) {
            if (type === 'globalupdate') {
                listeners.add(fn);
            } else {
                sauce?.addEventListener?.(type, fn);
            }
        },
        removeEventListener(type, fn) {
            if (type === 'globalupdate') {
                listeners.delete(fn);
            } else {
                sauce?.removeEventListener?.(type, fn);
            }
        },
    };
}
