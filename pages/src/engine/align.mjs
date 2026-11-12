// Where the rider is in the plan (docs/REVAMP_PLAN.md 1.3, 6.2). In an event the game's
// eventDistance and clock both sit at zero until the timing line, which is somewhere after
// the gate and different on every route (50 m in, 150 m in: no rule). So the line's plan
// metre comes from the end, as the 0.6 mod did: plan length minus the event's distance,
// when the plan is for this race; else the file's start_line_m. Outside an event, ride
// distance from the arm. The rider's manual offset is added. The plan is never rescaled to
// the event: a length mismatch is reported.

export const MISMATCH_FRACTION = 0.01;
export const LINE_MAX_M = 500;     // a plan may be longer than the event by this much: the gate-to-line stretch
export const OUT_OF_STEP_M = 100;  // the road puts the timing line this far from where the plan has it: the rider is told
export const UNMATCHED_AFTER_M = 500;  // this far into the race with a course and no match: the rider is told

export function inEvent(tick) {
    return Boolean(tick?.state?.eventSubgroupId ?? tick?.eventSubgroupId);
}

export function routeMatches(tick, plan) {
    const routeId = tick?.state?.routeId;
    return plan?.routeId != null && routeId != null && String(routeId) === String(plan.routeId);
}

// A number from a Sauce field: null, '' and missing are no reading (Number(null) is 0, which is not one).
export function numberOrNull(v) {
    if (v == null || v === '' || typeof v === 'boolean') {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function rideDistanceM(tick) {
    return numberOrNull(tick?.state?.distance);
}

export function eventDistanceM(tick) {
    return numberOrNull(tick?.state?.eventDistance);
}

/** The event's length in metres when Sauce reports it by distance. */
export function eventLengthM(tick) {
    const end = numberOrNull(tick?.remainingEnd);
    return tick?.remainingMetric === 'distance' && end != null && end > 0 ? end : null;
}

/** Sauce's distance to go in metres, when it reports one by distance; else null. */
export function distanceToGoM(tick) {
    return tick?.remainingMetric === 'distance' ? numberOrNull(tick?.remaining) : null;
}

/** Plan length minus event length when that is a gate-to-line stretch (0 to LINE_MAX_M); else null. */
export function lineOffsetM(tick, plan) {
    const eventM = eventLengthM(tick);
    if (eventM == null || !(plan?.lengthM > 0) || plan.fromHere) {
        return null;
    }
    const diff = plan.lengthM - eventM;
    return diff >= 0 && diff <= LINE_MAX_M ? diff : null;
}

/** The plan metre of the game's event metre 0: the timing line. */
export function lineInPlanM(tick, plan) {
    if (plan?.fromHere) {
        return 0;     // a plan from here starts where the rider was: no line
    }
    return lineOffsetM(tick, plan) ?? plan?.startLineM ?? 0;
}

/**
 * How the plan metre is found, for the view (course.mjs): 'course' when the rider's position is
 * matched on the plan's own course (locked, or carried on the odometer after a loss), 'line' when the line is given by the event's length
 * or the file's start_line_m, 'start' when nothing gives it (the line is taken as the plan's
 * start). lineM is the line in plan metres and residualM the last fix's along-road disagreement.
 */
export function alignmentOf(tick, plan, course = null) {
    if (course && (course.locked === true || Number.isFinite(course.m))) {
        // Locked on the road, or carried on the odometer after a loss (not locked then).
        // outOfStepM: the road puts the timing line somewhere else than the plan has it (the
        // event's length or the file's start_line_m: lineInPlanM). The targets follow the road,
        // but the plan's first metres (or the race's, when negative) are not the race's, and as
        // many at the far end are not planned.
        const stepM = Number.isFinite(course.lineM) ? course.lineM - lineInPlanM(tick, plan) : null;
        return {
            mode: 'course', locked: course.locked === true, lineM: course.lineM, residualM: course.locked ? course.residualM : null,
            outOfStepM: stepM != null && Math.abs(stepM) >= OUT_OF_STEP_M ? stepM : null, unmatched: false,
        };
    }
    const given = plan && !plan.fromHere && (lineOffsetM(tick, plan) != null || plan.startLineM != null);
    // A plan with a course, well into the event, and the road never matched: the targets are
    // placed by distance alone, which is only right when the plan was laid out from the line.
    const ed = eventDistanceM(tick);
    const unmatched = Boolean(plan?.course && !plan.fromHere && inEvent(tick) && ed != null && ed > UNMATCHED_AFTER_M);
    return {mode: given ? 'line' : 'start', locked: false, lineM: lineInPlanM(tick, plan), residualM: null, outOfStepM: null, unmatched};
}

/**
 * Plan metre for a tick, or null when nothing places the rider. courseM, when given, is the
 * plan metre the course matched (in an event, not a plan from here); the old rule otherwise.
 */
export function planMetre(tick, {offsetM = 0, anchorDistanceM = null, plan = null, courseM = null} = {}) {
    let base = null;
    if (plan?.fromHere) {
        // A plan from here: ride distance from where it was made, in an event or out of one.
        const ride = rideDistanceM(tick);
        base = ride != null ? ride - plan.fromHere.rideM : null;
    } else if (inEvent(tick) && Number.isFinite(courseM)) {
        base = courseM;
    } else if (inEvent(tick)) {
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
    if (eventM == null || !(plan?.lengthM > 0) || plan.fromHere) {
        return null;
    }
    const diff = eventM - plan.lengthM;
    if (diff > MISMATCH_FRACTION * plan.lengthM || diff < -LINE_MAX_M) {
        return diff;
    }
    return null;
}
