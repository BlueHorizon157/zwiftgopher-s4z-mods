// Is there a newer TT HUD? (Dave, 2026-11-12: the HUD says so before a ride, not only the
// settings page.) The latest GitHub release, else the highest version among the tags, checked at
// most once a day for every window together (Sauce's shared storage). Pure apart from the fetch
// and the storage it is given, so test/update-check.test.mjs runs it in Node.

export const REPO = 'BlueHorizon157/zwiftgopher-s4z-mods';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const UPDATE_CHECK_MS = 24 * 3600 * 1000;
export const STORAGE_KEY = '/zg-tt/update-check';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// The tags come sorted by name as text (v0.9.3 before v0.10.0), so all of them are read and the
// highest version taken.
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
export async function fetchLatest(fetchFn) {
    const get = async url => {
        const res = await fetchFn(url, {headers: {Accept: 'application/vnd.github+json'}});
        return res.ok ? res.json() : null;
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
 * {latest, available}: the newest version known (from the day's check, or a new one when that is
 * older than UPDATE_CHECK_MS) and whether it is newer than current. storage: {get(key), set(key,
 * value)}. A failed check keeps what was known and is not tried again for an hour.
 */
export async function checkForUpdate({fetchFn, storage, current, now = Date.now()}) {
    const cached = storage?.get?.(STORAGE_KEY) || {};
    let latest = typeof cached.latest === 'string' ? cached.latest : null;
    if (!cached.at || now - cached.at > UPDATE_CHECK_MS) {
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
