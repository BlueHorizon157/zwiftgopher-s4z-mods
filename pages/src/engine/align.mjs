// Where the rider is in the plan (docs/REVAMP_PLAN.md 1.3, 6.2). In an event the game's
// eventDistance and clock both sit at zero until the timing line, which is somewhere after
// the gate and different on every route (50 m in, 150 m in: no rule). So the line's plan
// metre comes from the end, as the 0.6 mod did: plan length minus the event's distance,
// when the plan is for this race; else the file's start_line_m. Outside an event, ride
// distance from the arm. The rider's manual offset is added. The plan is never rescaled to
// the event: a length mismatch is reported.

export const MISMATCH_FRACTION = 0.01;
export const LINE_MAX_M = 500;     // a plan may be longer than the event by this much: the gate-to-line stretch

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

/** The event's length in metres when Sauce reports it by distance. */
export function eventLengthM(tick) {
    const end = Number(tick?.remainingEnd);
    return tick?.remainingMetric === 'distance' && Number.isFinite(end) && end > 0 ? end : null;
}

/** Plan length minus event length when that is a gate-to-line stretch (0 to LINE_MAX_M); else null. */
export function lineOffsetM(tick, plan) {
    const eventM = eventLengthM(tick);
    if (eventM == null || !(plan?.lengthM > 0)) {
        return null;
    }
    const diff = plan.lengthM - eventM;
    return diff >= 0 && diff <= LINE_MAX_M ? diff : null;
}

/** The plan metre of the game's event metre 0: the timing line. */
export function lineInPlanM(tick, plan) {
    return lineOffsetM(tick, plan) ?? plan?.startLineM ?? 0;
}

/** Plan metre for a tick, or null when nothing places the rider. */
export function planMetre(tick, {offsetM = 0, anchorDistanceM = null, plan = null} = {}) {
    let base = null;
    if (inEvent(tick)) {
        const d = eventDistanceM(tick);
        base = d == null ? null : d + lineInPlanM(tick, plan);
    } else if (anchorDistanceM != null) {
        const ride = rideDistanceM(tick);
        base = ride != null ? ride - anchorDistanceM : null;
    }
    return base == null ? null : base + (Number(offsetM) || 0);
}

/**
 * Event length minus plan length when the plan is not for this race: the event longer by
 * over 1 %, or the plan longer by more than a gate-to-line stretch; else null.
 */
export function mismatchM(tick, plan) {
    const eventM = eventLengthM(tick);
    if (eventM == null || !(plan?.lengthM > 0)) {
        return null;
    }
    const diff = eventM - plan.lengthM;
    if (diff > MISMATCH_FRACTION * plan.lengthM || diff < -LINE_MAX_M) {
        return diff;
    }
    return null;
}
