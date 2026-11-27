// Is there a newer release? The latest GitHub release, else the highest tag version, checked at
// most once a day for all windows (shared storage). Unauthenticated GETs to api.github.com;
// nothing about the rider is sent. Pure: fetch and storage are arguments.

export const REPO = 'BlueHorizon157/zwiftgopher-s4z-mods';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const UPDATE_CHECK_MS = 24 * 3600 * 1000;
export const STORAGE_KEY = '/zg-tt/update-check';
export const TIMEOUT_MS = 8000;
// A check in progress is claimed for this long, so windows starting together don't all ask.
export const CLAIM_MS = 60 * 1000;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// Tags are sorted as text (v0.9.3 before v0.10.0): read up to 100, take the highest version.
const TAGS_API = `https://api.github.com/repos/${REPO}/tags?per_page=100`;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/;

/** Positive when a is newer than b ("0.10.0" against "0.9.3"); a pre-release is older than its release. */
export function compareVersions(a, b) {
    const parse = v => {
        const [core, pre = ''] = String(v).replace(/^v/i, '').split('-');
        return {parts: core.split('.').map(n => parseInt(n, 10) || 0), pre};
    };
    const va = parse(a);
    const vb = parse(b);
    for (let i = 0; i < Math.max(va.parts.length, vb.parts.length); i++) {
        const d = (va.parts[i] ?? 0) - (vb.parts[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return va.pre && !vb.pre ? -1 : (!va.pre && vb.pre ? 1 : 0);
}

/** The highest version among GitHub tags ([{name: 'v0.9.3'}, ...]), without the v; null when none is one. */
export function newestTag(tags) {
    let best = null;
    for (const t of Array.isArray(tags) ? tags : []) {
        const name = String(t?.name ?? '');
        if (VERSION_RE.test(name) && (best === null || compareVersions(name, best) > 0)) {
            best = name;
        }
    }
    return best === null ? null : best.replace(/^v/i, '');
}

/** The newest version GitHub has, without the v, or null when it cannot be read. */
export async function fetchLatest(fetchFn, timeoutMs = TIMEOUT_MS) {
    const get = async url => {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
        try {
            const res = await fetchFn(url, {headers: {Accept: 'application/vnd.github+json'}, signal: ctl?.signal});
            return res.ok ? await res.json() : null;
        } finally {
            clearTimeout(timer);
        }
    };
    try {
        const release = await get(LATEST_API);
        const tag = String(release?.tag_name ?? '');
        if (release && !release.draft && VERSION_RE.test(tag)) {
            return tag.replace(/^v/i, '');
        }
        return newestTag(await get(TAGS_API));
    } catch {
        return null;
    }
}

/**
 * {latest, available}: the newest version known (cached for UPDATE_CHECK_MS) and whether it is
 * newer than current. storage: {get(key), set(key, value)}. A failed check keeps the old answer
 * and is retried after an hour.
 */
export async function checkForUpdate({fetchFn, storage, current, now = Date.now()}) {
    const cached = storage?.get?.(STORAGE_KEY) || {};
    let latest = typeof cached.latest === 'string' ? cached.latest : null;
    if (!cached.at || now - cached.at > UPDATE_CHECK_MS) {
        // No await between reading the cache and writing the claim, so only the first window asks.
        storage?.set?.(STORAGE_KEY, {at: now - UPDATE_CHECK_MS + CLAIM_MS, latest});
        const fetched = await fetchLatest(fetchFn);
        if (fetched) {
            latest = fetched;
            storage?.set?.(STORAGE_KEY, {at: now, latest});
        } else {
            storage?.set?.(STORAGE_KEY, {at: now - UPDATE_CHECK_MS + 3600 * 1000, latest});
        }
    }
    return {latest, available: Boolean(latest && current && compareVersions(latest, current) > 0)};
}

// A copy installed from Sauce's mod store is kept up to date by Sauce, so it does not ask GitHub.

/** This copy's mod id: Sauce serves a mod's pages under /mods/<id>/. Null anywhere else. */
export function modIdFromPath(pathname) {
    const m = /^\/mods\/([^/]+)\//.exec(String(pathname ?? ''));
    return m ? decodeURIComponent(m[1]) : null;
}

/**
 * 'store' (packed, from Sauce's mod store), 'folder' (unpacked) or null when mods
 * (getAvailableMods) lacks this id. The id is Sauce's top-level one: a store install ignores the
 * manifest id.
 */
export function installKindOf(mods, id) {
    const mine = id && Array.isArray(mods) ? mods.find(m => m?.id === id) : null;
    return mine ? (mine.packed ? 'store' : 'folder') : null;
}

/** installKindOf for a page, from Sauce. Null when Sauce cannot say (old Sauce, test page). */
export async function askInstallKind(rpc, pathname) {
    const id = modIdFromPath(pathname);
    if (!id || !rpc) {
        return null;
    }
    for (const method of ['getAvailableModsV1', 'getAvailableMods']) {
        try {
            return installKindOf(await rpc[method](), id);
        } catch {
            // An older Sauce without this call: try the next name.
        }
    }
    return null;
}

let kindAsked = null;
export function installKind(rpc, pathname) {
    kindAsked ??= askInstallKind(rpc, pathname);
    return kindAsked;
}
