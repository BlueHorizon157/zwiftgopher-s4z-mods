// Shared state between the mod's windows (docs/REVAMP_PLAN.md §4.3): the plan library,
// the active plan, the rider's controls, the rider link and the shelf sync state
// (TT/RIDE_DAY_PLAN.md 2.1, 2.4), in Sauce's global storage keys (they start with '/'),
// written when something changes, never per tick. Migrates what 0.6.x kept under
// 'tt-dashboard-state' and '/tt-dashboards/shared-state' once.
import {storage} from './sauce.mjs';
import {dropTwins, shelfLeavers} from './plan-library.mjs';

export {courseOf, sameCourse} from './plan-library.mjs';

export const KEYS = {
    plans: '/zg-tt/plans',
    active: '/zg-tt/active',
    controls: '/zg-tt/controls',
    link: '/zg-tt/link',
    shelf: '/zg-tt/shelf',
};
const LEGACY_SHARED = '/tt-dashboards/shared-state';
const LEGACY_WINDOW = 'tt-dashboard-state';
// A week of event plans from the shelf fits; each entry is a 6–17 KB plan file.
export const MAX_PLANS = 10;

export function library() {
    const lib = storage?.get(KEYS.plans);
    return lib && typeof lib === 'object' && lib.plans ? lib : {plans: {}};
}

export function listPlans() {
    return Object.entries(library().plans)
        .map(([code, entry]) => ({code, ...entry}))
        .sort((a, b) => (b.loadedAt ?? 0) - (a.loadedAt ?? 0));
}

export function getPlanRaw(code) {
    return code ? library().plans[code]?.raw ?? null : null;
}

/** The library entry for a code (raw plus what the shelf said about it), or null. */
export function getPlanEntry(code) {
    return code ? library().plans[code] ?? null : null;
}

/**
 * Keep a plan under its code (the newest ten), and make it active. A plan from the shelf
 * carries its event, source and publication, so the windows can pick it for the event and
 * tell a republished plan from the one they have.
 *
 * One plan per course (Dave, 2026-11-12): a plan for a course the library already has a plan
 * for replaces it, whatever its code; the replaced plan's place as the active plan passes to
 * the new one. Plans from here are kept apart.
 */
export function savePlan(code, raw, {activate = true, expiresAt = null, event = null, source = null, publishedAt = null, shelf = false} = {}) {
    const lib = library();
    const twins = dropTwins(lib.plans, code, raw);
    const tookActive = twins.includes(getActiveCode());
    lib.plans[code] = {
        raw,
        loadedAt: Date.now(),
        expiresAt,
        routeId: raw?.route?.id != null ? String(raw.route.id) : null,
        routeName: raw?.route?.name ?? null,
        timeText: raw?.summary?.time_text ?? null,
        event: event ?? raw?.meta?.event ?? null,
        source,
        publishedAt: publishedAt ?? raw?.meta?.published?.at ?? null,
        shelf,
    };
    const codes = Object.keys(lib.plans).sort((a, b) => (lib.plans[b].loadedAt ?? 0) - (lib.plans[a].loadedAt ?? 0));
    for (const old of codes.slice(MAX_PLANS)) {
        delete lib.plans[old];
    }
    storage.set(KEYS.plans, lib);
    if (activate) {
        setActive(code);
    } else if (tookActive) {
        // The plan that was active is gone: its replacement is the plan, as shared.
        storage.set(KEYS.active, {code, card: null, at: Date.now()});
    }
}

/**
 * The plans from the shelf that the shelf no longer has (replaced by a newer plan for their
 * course, or taken off in the planner) leave the library. codes: the shelf's listing.
 * Returns the codes removed.
 */
export function pruneShelf(codes) {
    const lib = library();
    const gone = shelfLeavers(lib.plans, codes);
    if (!gone.length) {
        return [];
    }
    for (const code of gone) {
        delete lib.plans[code];
    }
    storage.set(KEYS.plans, lib);
    if (gone.includes(getActiveCode())) {
        setActive(null);
    }
    return gone;
}

export function removePlan(code) {
    const lib = library();
    delete lib.plans[code];
    storage.set(KEYS.plans, lib);
    if (getActiveCode() === code) {
        setActive(null);
    }
}

export function getActiveCode() {
    return storage?.get(KEYS.active)?.code ?? null;
}

/** The strategy card the rider chose for the active plan (5.2), or null for the plan as shared. */
export function getActiveCard() {
    return storage?.get(KEYS.active)?.card ?? null;
}

/** card: the strategy card to ride; left out, a different plan starts as shared and the same plan keeps its card. */
export function setActive(code, card) {
    const same = (code ?? null) === getActiveCode();
    if (!same) {
        // A different plan starts with neutral offset and bias, in every window.
        setControls({offsetM: 0, bias: 1});
    }
    const keep = card === undefined ? (same ? getActiveCard() : null) : card;
    storage.set(KEYS.active, {code: code ?? null, card: code ? keep ?? null : null, at: Date.now()});
}

export function setActiveCard(card) {
    setActive(getActiveCode(), card);
}

export function getActivePlanRaw() {
    return getPlanRaw(getActiveCode());
}

/** The plan in the library made for this route, if any. */
export function planForRoute(routeId) {
    if (routeId == null) {
        return null;
    }
    return listPlans().find(p => p.routeId === String(routeId)) ?? null;
}

/** The newest plan made for this event: by its pen first, then by the event (TT/RIDE_DAY_PLAN.md 2.4). */
export function planForEvent(eventId, subgroupId = null) {
    const plans = listPlans();
    return (subgroupId != null ? plans.find(p => p.event?.subgroup_id != null && String(p.event.subgroup_id) === String(subgroupId)) : null)
        ?? (eventId != null ? plans.find(p => p.event?.id != null && String(p.event.id) === String(eventId)) : null)
        ?? null;
}

// ---- the rider link and the shelf (TT/RIDE_DAY_PLAN.md 2.1, 2.4) ----

/**
 * The link to the planner: {token, state: 'pending' | 'linked' | 'expired' | 'revoked', code,
 * expiresAt, deviceId, linkId, zwiftId, riderName, plannerLabel, startedAt, linkedAt}, or
 * null. The token is the mod's own; the server keeps its hash.
 */
export function getLink() {
    const link = storage?.get(KEYS.link);
    return link && typeof link === 'object' && link.token ? link : null;
}

export function setLink(link) {
    storage.set(KEYS.link, link && link.token ? {...link} : null);
}

export function clearLink() {
    storage.set(KEYS.link, null);
}

/**
 * Shelf sync state every window shares: {etag, lastPollAt, lastPollBy, lastSyncAt, offer:
 * {code, routeName, timeText, at} | null, unsupportedAt}. One window polls a minute.
 */
export function getShelf() {
    const shelf = storage?.get(KEYS.shelf);
    return shelf && typeof shelf === 'object' ? shelf : {};
}

export function setShelf(patch) {
    storage.set(KEYS.shelf, {...getShelf(), ...patch});
}

export function getControls() {
    const c = storage?.get(KEYS.controls) || {};
    return {
        offsetM: Number.isFinite(Number(c.offsetM)) ? Number(c.offsetM) : 0,
        bias: Number.isFinite(Number(c.bias)) && Number(c.bias) > 0 ? Number(c.bias) : 1,
        resetAt: Number(c.resetAt) || 0,
    };
}

export function setControls(patch) {
    storage.set(KEYS.controls, {...getControls(), ...patch});
}

/** Called with (key, value) when another window changes one of our keys. */
export function onChange(callback) {
    const keys = new Set(Object.values(KEYS));
    storage?.addEventListener('globalupdate', ev => {
        if (ev?.data && keys.has(ev.data.key)) {
            callback(ev.data.key, ev.data.value);
        }
    });
}

/** Bring a 0.6.x plan and controls across once; harmless when there is nothing. */
export function migrate() {
    if (!storage || storage.get(KEYS.active) != null) {
        return false;
    }
    const shared = storage.get(LEGACY_SHARED) || {};
    const mine = storage.get(LEGACY_WINDOW) || {};
    const raw = shared.plan || mine.plan || null;
    let migrated = false;
    if (raw && Array.isArray(raw.intervals) && raw.intervals.length) {
        savePlan('legacy', raw);
        migrated = true;
    } else {
        setActive(null);
    }
    const offsetM = Number(shared.distanceOffset ?? mine.distanceOffset);
    const bias = Number(shared.powerBias ?? mine.powerBias);
    setControls({
        offsetM: Number.isFinite(offsetM) ? offsetM : 0,
        bias: Number.isFinite(bias) && bias > 0 ? bias : 1,
    });
    if (mine.plan) {
        const {plan, homeAthleteId, ...prefs} = mine;
        storage.set(LEGACY_WINDOW, prefs);
    }
    storage.delete?.(LEGACY_SHARED);
    return migrated;
}
