// What the rider did against the plan (docs/REVAMP_PLAN.md 1.5): per-interval time and
// power on the race clock, the pacing ratio, and the finish prediction. Pure functions
// over a tracking record; nothing here reads a clock or a store.

export const PARTIAL_TOLERANCE_M = 25;
export const MIN_PACING_SAMPLE_S = 60;
export const PACING_MIN = 0.25;
export const PACING_MAX = 4;

export function createTracking() {
    return {stats: [], lastIndex: null, lastRaceS: null};
}

function begin(tracking, index, {raceS, planM, interval, partial}) {
    tracking.stats[index] = {
        index,
        startRaceS: raceS,
        startPlanM: planM,
        elapsedS: 0,
        workJ: 0,
        avgPowerW: null,
        finished: false,
        partial,
        endRaceS: null,
        planDurationS: interval?.durationS ?? null,
    };
}

function advanceOne(stats, raceS, power) {
    if (!stats || stats.finished || stats.lastRaceS == null) {
        if (stats) {
            stats.lastRaceS = raceS;
        }
        return;
    }
    const dt = raceS - stats.lastRaceS;
    if (dt <= 0) {
        return;
    }
    stats.elapsedS += dt;
    if (Number.isFinite(power)) {
        stats.workJ += power * dt;
        stats.avgPowerW = stats.workJ / stats.elapsedS;
    }
    stats.lastRaceS = raceS;
}

/**
 * One tick on the race clock. index is the interval the rider is in (cursor.locate);
 * atStart marks the tick the clock started on: the interval that contains the start line
 * (startLineM into the plan) counts as fully ridden; a join beyond that is partial.
 */
export function advance(tracking, {index, raceS, power, planM, intervals, atStart = false, startLineM = 0}) {
    if (!Number.isFinite(raceS)) {
        return tracking;
    }
    const prev = tracking.lastIndex;
    if (prev !== index) {
        if (prev != null && prev >= 0 && prev < intervals.length) {
            const s = tracking.stats[prev];
            if (s && !s.finished) {
                advanceOne(s, raceS, power);
                s.finished = true;
                s.endRaceS = raceS;
            }
        }
        if (index >= 0 && index < intervals.length && !tracking.stats[index]?.finished) {
            const iv = intervals[index];
            // At the start the rider is already past the pen metres and the line; a join
            // further into an interval than that is partial.
            const allowance = PARTIAL_TOLERANCE_M + (atStart ? startLineM : 0);
            const partial = Number.isFinite(planM) && planM - iv.startM > allowance;
            begin(tracking, index, {raceS, planM, interval: iv, partial});
            tracking.stats[index].lastRaceS = raceS;
        }
        tracking.lastIndex = index;
    } else if (index >= 0 && index < intervals.length) {
        advanceOne(tracking.stats[index], raceS, power);
    }
    tracking.lastRaceS = raceS;
    return tracking;
}

/** Actual / plan time over the completed, fully ridden intervals; 1 until a minute of them. */
export function pacingRatio(tracking, intervals) {
    let planS = 0;
    let actualS = 0;
    for (const s of tracking.stats) {
        if (!s?.finished || s.partial) {
            continue;
        }
        const iv = intervals[s.index];
        if (!(iv?.durationS > 0)) {
            continue;
        }
        planS += iv.durationS;
        actualS += s.elapsedS;
    }
    if (planS < MIN_PACING_SAMPLE_S || actualS <= 0) {
        return 1;
    }
    return Math.min(PACING_MAX, Math.max(PACING_MIN, actualS / planS));
}

/** Plan time at a plan metre, interpolated inside the interval. */
export function planTimeAtMetre(intervals, planM) {
    if (!Number.isFinite(planM) || !intervals.length) {
        return 0;
    }
    if (planM <= intervals[0].startM) {
        return 0;
    }
    for (const iv of intervals) {
        if (planM < iv.endM) {
            const f = iv.lengthM > 0 ? (planM - iv.startM) / iv.lengthM : 1;
            return iv.startTimeS + f * iv.durationS;
        }
    }
    return intervals.at(-1).endTimeS;
}

/**
 * Finish prediction from the race clock: what is left of the plan from here, scaled by
 * the pacing ratio. planTimeAtStart is the plan time at the metre where the clock
 * started, so a plan from the pen compares with a clock from the line.
 */
export function predict({tracking, plan, index, planM, raceS, planTimeAtStart = 0}) {
    const intervals = plan.intervals;
    if (!Number.isFinite(raceS) || !intervals.length) {
        return null;
    }
    const ratio = pacingRatio(tracking, intervals);
    const remainingPlanS = Math.max(0, plan.timeS - planTimeAtMetre(intervals, planM));
    const remainingS = remainingPlanS * ratio;
    const planFromStartS = Math.max(0, plan.timeS - planTimeAtStart);
    const totalS = raceS + remainingS;
    const finished = index >= intervals.length;
    return {
        pacing: ratio,
        remainingPlanS,
        remainingS: finished ? 0 : remainingS,
        totalS: finished ? raceS : totalS,
        planTotalS: planFromStartS,
        deltaS: (finished ? raceS : totalS) - planFromStartS,
        sampleS: tracking.stats.filter(s => s?.finished && !s.partial).reduce((sum, s) => sum + (intervals[s.index]?.durationS ?? 0), 0),
    };
}
