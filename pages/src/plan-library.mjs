// Plan library rules that need no Sauce (store.mjs keeps the library): one plan per course, and
// which shelf plans have left the shelf. Pure, so test/plan-library.test.mjs runs them in Node.
// The planner's shelf applies the same course rule server-side.

/**
 * A plan's course: its route and either the custom distance (metres) or the laps; null for a
 * plan from here (the rest of one ride) or a plan without a route.
 */
export function courseOf(raw) {
    if (!raw || raw.meta?.from_here) {
        return null;
    }
    const routeId = raw.route?.id != null ? String(raw.route.id) : '';
    if (!routeId) {
        return null;
    }
    const km = Number(raw.route?.target_distance_km);
    return km > 0
        ? {routeId, distanceM: Math.round(km * 1000), laps: null}
        : {routeId, distanceM: null, laps: Math.max(1, Number(raw.route?.laps) || 1)};
}

/** The same course: the same route and laps, or the same route and a distance within 1 % (50 m at least). */
export function sameCourse(a, b) {
    if (!a || !b || a.routeId !== b.routeId) {
        return false;
    }
    if (a.distanceM != null || b.distanceM != null) {
        return a.distanceM != null && b.distanceM != null
            && Math.abs(a.distanceM - b.distanceM) <= Math.max(50, 0.01 * Math.max(a.distanceM, b.distanceM));
    }
    return a.laps === b.laps;
}

/**
 * Remove from plans ({code: entry with .raw}) every other plan for raw's course, before raw is
 * saved under code. Returns the codes removed. Plans from here are never removed nor remove.
 */
export function dropTwins(plans, code, raw) {
    const course = courseOf(raw);
    if (!course) {
        return [];
    }
    const gone = [];
    for (const [other, entry] of Object.entries(plans)) {
        if (other !== String(code) && sameCourse(course, courseOf(entry?.raw))) {
            delete plans[other];
            gone.push(other);
        }
    }
    return gone;
}

/**
 * Shelf plans (entry.shelf) that are no longer in the shelf's listing: a newer plan for the
 * course replaced them, or the rider took them off in the planner. codes: the listing's. Plans
 * loaded by code stay, as do the active plan and expired plans (the shelf stops listing those but
 * they remain usable). now: the clock (ms), for the expiry.
 */
export function shelfLeavers(plans, codes, {activeCode = null, now = Date.now()} = {}) {
    const keep = new Set((codes ?? []).map(String));
    return Object.entries(plans)
        .filter(([code, entry]) => entry?.shelf && !keep.has(code) && code !== activeCode && !hasExpired(entry, now))
        .map(([code]) => code);
}

/**
 * Whether a library entry's expiresAt has passed: an ISO time (the shelf's listing), the SQL text
 * the share endpoint gives (no zone: UTC), or epoch seconds or milliseconds. No expiry: no.
 */
export function hasExpired(entry, now = Date.now()) {
    const at = entry?.expiresAt;
    if (at == null || at === '') {
        return false;
    }
    const text = String(at).trim();
    const ms = typeof at === 'number' ? at * (at < 1e12 ? 1000 : 1)
        : Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) && ms <= now;
}
