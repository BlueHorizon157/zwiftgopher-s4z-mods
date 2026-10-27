// Where the rider is in the plan (docs/REVAMP_PLAN.md 1.3). In an event the game's
// eventDistance (metres from the start) is the plan metre; outside one, ride distance from
// the arm. The rider's manual offset is added. The plan is never rescaled to the event:
// a length mismatch is reported.

export const MISMATCH_FRACTION = 0.01;

export function inEvent(tick) {
    return Boolean(tick?.state?.eventSubgroupId ?? tick?.eventSubgroupId);
}

export function routeMatches(tick, plan) {
    const routeId = tick?.state?.routeId;
    return plan?.routeId != null && routeId != null && String(routeId) === String(plan.routeId);
}

export function rideDistanceM(tick) {
    const d = Number(tick?.state?.distance);
    return Number.isFinite(d) ? d : null;
}

export function eventDistanceM(tick) {
    const d = Number(tick?.state?.eventDistance);
    return Number.isFinite(d) ? d : null;
}

/** Plan metre for a tick, or null when nothing places the rider. */
export function planMetre(tick, {offsetM = 0, anchorDistanceM = null} = {}) {
    let base = null;
    if (inEvent(tick)) {
        base = eventDistanceM(tick);
    } else if (anchorDistanceM != null) {
        const ride = rideDistanceM(tick);
        base = ride != null ? ride - anchorDistanceM : null;
    }
    return base == null ? null : base + (Number(offsetM) || 0);
}

/** The event's length in metres when Sauce reports it by distance. */
export function eventLengthM(tick) {
    const end = Number(tick?.remainingEnd);
    return tick?.remainingMetric === 'distance' && Number.isFinite(end) && end > 0 ? end : null;
}

/** Event length minus plan length, or null when unknown or within 1 %. */
export function mismatchM(tick, plan) {
    const eventM = eventLengthM(tick);
    if (eventM == null || !(plan?.lengthM > 0)) {
        return null;
    }
    const diff = eventM - plan.lengthM;
    return Math.abs(diff) / plan.lengthM > MISMATCH_FRACTION ? diff : null;
}
