// State shared between the mod's windows, kept in localStorage under keys Sauce ignores.
//
// Sauce's storage treats every key starting with '/' as global, and every Sauce window's settings
// store hears a write to a global key as a change to its own settings: the Watching window
// reloads, Nearby and Groups redraw. The mod writes shared keys often (heartbeats every couple of
// seconds), so under '/zg-tt/' it would make those windows flicker.
//
// So the mod stores them under '~zg-tt/'. Sauce's storage handler only reacts to keys starting
// with '/' or with a window's own '<window id>-', and window ids never start with '~'. The mod's
// windows hear each other through the browser's 'storage' event, re-emitted as 'globalupdate'
// with the key in its '/zg-tt/' form, so callers keep their keys and listeners. Keys outside the
// mod's prefix go to Sauce's storage unchanged.
//
// Older versions stored the mod's keys in Sauce's storage under '/zg-tt/'. A key missing under
// '~zg-tt/' is read from there once and copied across; Sauce's copy is left alone. A deleted key
// is stored as null, so the old copy cannot come back.

export const MOD_PREFIX = '/zg-tt/';
export const LOCAL_PREFIX = '~zg-tt/';

const localKey = key => LOCAL_PREFIX + key.slice(MOD_PREFIX.length);

/**
 * An in-memory copy of the mod's keys in a localStorage, with the same interface. A replay window
 * (?replay=) reads from it and writes only into the copy, so it never changes the real windows' state.
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

/** Sauce's storage with writes ignored (a replay window's non-mod keys). */
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
 * local: a localStorage; win: where 'storage' events arrive; sauce: Sauce's storage
 * (common.storage), used for keys outside the mod's prefix and for the old copies.
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
    // Sauce's global updates for keys outside the mod's prefix pass through to the same listeners.
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
