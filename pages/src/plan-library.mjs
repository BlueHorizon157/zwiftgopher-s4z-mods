// The plan library's rules that need no Sauce (store.mjs keeps the library in Sauce's storage):
// one plan per course, and which plans from the shelf have left it. Pure, so test/plan-library
// .test.mjs runs them in Node.
//
// One plan per course (Dave, 2026-11-12): "only the last one and only one should show up in the
// list of plans ... any plan on the same course and length should replace". The planner's shelf
// keeps one plan per course too (TTShelf::publish), with the same rule (TTShelf::courseOf,
// sameCourse).

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
 * The plans that came from the shelf (entry.shelf) and are not in its listing any more: a newer
 * plan for the course took their place, or the rider took them off in the planner. codes: the
 * listing's. A plan loaded by its code (not from the shelf) stays.
 */
export function shelfLeavers(plans, codes) {
    const keep = new Set((codes ?? []).map(String));
    return Object.entries(plans).filter(([code, entry]) => entry?.shelf && !keep.has(code)).map(([code]) => code);
}
