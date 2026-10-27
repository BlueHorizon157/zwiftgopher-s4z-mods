// Shared state between the mod's windows (docs/REVAMP_PLAN.md §4.3): the plan library,
// the active plan and the rider's controls, in Sauce's global storage keys (they start
// with '/'), written when the rider changes them, never per tick. Migrates what 0.6.x
// kept under 'tt-dashboard-state' and '/tt-dashboards/shared-state' once.
import {storage} from './sauce.mjs';

export const KEYS = {
    plans: '/zg-tt/plans',
    active: '/zg-tt/active',
    controls: '/zg-tt/controls',
};
const LEGACY_SHARED = '/tt-dashboards/shared-state';
const LEGACY_WINDOW = 'tt-dashboard-state';
const MAX_PLANS = 5;

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

/** Keep a plan under its code (the newest five), and make it active. */
export function savePlan(code, raw, {activate = true, expiresAt = null} = {}) {
    const lib = library();
    lib.plans[code] = {
        raw,
        loadedAt: Date.now(),
        expiresAt,
        routeId: raw?.route?.id != null ? String(raw.route.id) : null,
        routeName: raw?.route?.name ?? null,
        timeText: raw?.summary?.time_text ?? null,
    };
    const codes = Object.keys(lib.plans).sort((a, b) => (lib.plans[b].loadedAt ?? 0) - (lib.plans[a].loadedAt ?? 0));
    for (const old of codes.slice(MAX_PLANS)) {
        delete lib.plans[old];
    }
    storage.set(KEYS.plans, lib);
    if (activate) {
        setActive(code);
    }
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
