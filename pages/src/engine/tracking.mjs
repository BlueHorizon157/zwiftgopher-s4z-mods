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

// The finish prediction (docs/REVAMP_PLAN.md 6.1). The 2026-10-27 race: a clock that
// started 10 s before the official timer put +11 s on a 46 s first interval, and the old
// time ratio (actual / plan over the ridden intervals, extrapolated over the rest) turned
// that into "2:15 behind" the moment the second interval closed. So: the clock deficit is
// carried as the constant it is, and the rest of the race is timed from the rider's power
// against the plan, through the physics of each interval.
export const POWER_WINDOW_S = 300;      // the power ratio looks back this far
export const POWER_PRIOR_S = 60;        // and counts for half after this much sample
export const POWER_RATIO_MIN = 0.5;
export const POWER_RATIO_MAX = 1.5;
const BIKE_KG = 9;
const DEFAULT_RIDER_KG = 75;
const CRR = 0.005;
const G = 9.81;

/**
 * Recent actual / target power, time-weighted over the last POWER_WINDOW_S of racing,
 * shrunk towards 1 by POWER_PRIOR_S: {ratio, sampleS}. The current interval counts.
 */
export function powerRatio(tracking, intervals, raceS) {
    let weighted = 0;
    let sampleS = 0;
    const windowStart = raceS - POWER_WINDOW_S;
    for (const s of tracking.stats) {
        const iv = intervals[s?.index];
        if (!s || !(iv?.powerW > 0) || !(s.elapsedS > 0) || !Number.isFinite(s.avgPowerW)) {
            continue;
        }
        const endS = s.finished && s.endRaceS != null ? s.endRaceS : raceS;
        const overlap = Math.min(endS, raceS) - Math.max(s.startRaceS, windowStart);
        if (overlap <= 0) {
            continue;
        }
        weighted += overlap * (s.avgPowerW / iv.powerW);
        sampleS += overlap;
    }
    if (sampleS <= 0) {
        return {ratio: 1, sampleS: 0};
    }
    const raw = Math.min(POWER_RATIO_MAX, Math.max(POWER_RATIO_MIN, weighted / sampleS));
    const weight = sampleS / (sampleS + POWER_PRIOR_S);
    return {ratio: 1 + (raw - 1) * weight, sampleS};
}

/**
 * How an interval's time answers power: t ∝ P^-e with e = 1 / (1 + 2a), a the share of
 * the plan power that goes to the air (P = A v³ + B v). Flat: e ≈ 0.36; a steep climb
 * approaches 1.
 */
export function timeExponent(iv, riderKg = DEFAULT_RIDER_KG) {
    if (!(iv?.powerW > 0) || !(iv?.speedMs > 0)) {
        return 1 / 3;
    }
    const massKg = (Number.isFinite(riderKg) && riderKg > 0 ? riderKg : DEFAULT_RIDER_KG) + BIKE_KG;
    const grade = (Number(iv.grade) || 0) / 100;
    const roadW = massKg * G * (grade + CRR) * iv.speedMs;
    const aeroShare = Math.min(1, Math.max(0.1, 1 - roadW / iv.powerW));
    return 1 / (1 + 2 * aeroShare);
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

/** The plan's time from planM to finishM, with each interval scaled for the rider's power ratio. */
function remainingAtRatio(intervals, planM, finishM, ratio, riderKg) {
    let plan = 0;
    let scaled = 0;
    for (const iv of intervals) {
        const from = Math.max(iv.startM, planM);
        const to = Math.min(iv.endM, finishM);
        if (!(to > from) || !(iv.lengthM > 0)) {
            continue;
        }
        const planS = iv.durationS * (to - from) / iv.lengthM;
        plan += planS;
        scaled += planS * Math.pow(ratio, -timeExponent(iv, riderKg));
    }
    return {planS: plan, scaledS: scaled};
}

/**
 * Finish prediction from the race clock. planTimeAtStart is the plan time at the metre
 * where the clock started, so a plan from the pen compares with a clock from the line;
 * finishM is where the race ends (the event's distance when it is shorter than the plan).
 * deficitS is the clock against the plan at this metre; the rest is the plan's remaining
 * time at the rider's recent power. pacing is that power ratio.
 */
export function predict({tracking, plan, index, planM, raceS, planTimeAtStart = 0, finishM = null}) {
    const intervals = plan.intervals;
    if (!Number.isFinite(raceS) || !intervals.length) {
        return null;
    }
    const endM = Number.isFinite(finishM) && finishM > 0 ? Math.min(finishM, plan.lengthM) : plan.lengthM;
    const planTotalS = Math.max(0, planTimeAtMetre(intervals, endM) - planTimeAtStart);
    const here = Number.isFinite(planM) ? Math.min(Math.max(planM, intervals[0].startM), endM) : intervals[0].startM;
    const deficitS = raceS - Math.max(0, planTimeAtMetre(intervals, here) - planTimeAtStart);
    const {ratio, sampleS} = powerRatio(tracking, intervals, raceS);
    const {planS: remainingPlanS, scaledS} = remainingAtRatio(intervals, here, endM, ratio, plan.weightKg);
    const finished = index >= intervals.length || here >= endM;
    const remainingS = finished ? 0 : scaledS;
    const totalS = finished ? raceS : raceS + remainingS;
    return {
        pacing: ratio,
        timeRatio: pacingRatio(tracking, intervals),
        deficitS,
        finishM: endM,
        remainingPlanS,
        remainingS,
        totalS,
        planTotalS,
        deltaS: totalS - planTotalS,
        sampleS,
    };
}
