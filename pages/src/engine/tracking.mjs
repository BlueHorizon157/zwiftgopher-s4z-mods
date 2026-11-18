// What the rider did against the plan (docs/REVAMP_PLAN.md 1.5): per-interval time and
// power on the race clock, the pacing ratio, and the finish prediction. Pure functions
// over a tracking record; nothing here reads a clock or a store.

import {timeInto} from './plan.mjs';

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
        // The metre jumped past intervals at once (the course's lock moves it by the line): each
        // one jumped over is begun and closed at this tick, partial, so none is left without stats.
        if (prev != null && index > prev + 1) {
            for (let j = prev + 1; j < index && j < intervals.length; j++) {
                if (!tracking.stats[j]) {
                    begin(tracking, j, {raceS, planM, interval: intervals[j], partial: true});
                    tracking.stats[j].finished = true;
                    tracking.stats[j].endRaceS = raceS;
                }
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

/**
 * The race is over at the finish: the interval being ridden closes there, so its time is the
 * rider's to the finish and not to the plan's end (the course can put the finish past it).
 */
export function closeInterval(tracking, {raceS, power = null}) {
    const idx = tracking.lastIndex;
    const s = idx != null ? tracking.stats[idx] : null;
    if (s && !s.finished) {
        advanceOne(s, raceS, power);
        s.finished = true;
        s.endRaceS = raceS;
    }
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
//
// 2026-11-18 (The Fan Flats TT: "38 s behind" after a first interval ridden on time): the power
// ratio alone took 45 s at 241 W against 272 W for the next half hour, at 60 s of prior. The
// rider had crossed the line at 34.6 km/h, so the plan's power to get up to speed was not needed:
// on time, on less power. Now the rest of the race is also answered by the rider's speed against
// the plan at the power they rode (speedAgainstPlan, the countdown's measure, over the whole race),
// the first START_SKIP_S after the line count for neither, and the power ratio leans on the plan
// longer. Back-test on four recorded races with their plans (Fan Flats, California Dreamin',
// Scotland Smash, the Hilly mass start) and four made from them (the plan 4 % fast or slow, the
// targets 8-10 % up for the second half or the last third, as a rider who fades): mean error
// against the delta at the finish 11.3 → 7.2 s on the real races (first five minutes 19.5 →
// 10.3 s, worst moment 47 → 27 s), plan 4 % off 40 → 8 s, fades 14-15 → 16-17 s.
export const POWER_WINDOW_S = 600;      // the power ratio looks back this far
export const POWER_PRIOR_S = 300;       // and counts for half after this much sample
export const POWER_RATIO_MIN = 0.5;
export const POWER_RATIO_MAX = 1.5;
export const START_SKIP_S = 30;         // the race's first seconds (the launch, the speed carried over the line) count for neither
export const SPEED_PRIOR_S = 60;        // the speed against the plan counts for half after this much racing
export const SPEED_MIN = 0.6;
export const SPEED_MAX = 1.6;
const BIKE_KG = 9;
const DEFAULT_RIDER_KG = 75;
const CRR = 0.005;
const G = 9.81;

/**
 * Recent actual / target power, time-weighted over the last POWER_WINDOW_S of racing after the
 * first START_SKIP_S, shrunk towards 1 by POWER_PRIOR_S: {ratio, sampleS}. The current interval counts.
 */
export function powerRatio(tracking, intervals, raceS, {windowS = POWER_WINDOW_S, priorS = POWER_PRIOR_S, skipS = START_SKIP_S} = {}) {
    let weighted = 0;
    let sampleS = 0;
    const windowStart = Math.max(raceS - windowS, skipS);
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
    const weight = sampleS / (sampleS + priorS);
    return {ratio: 1 + (raw - 1) * weight, sampleS};
}

/**
 * The rider's speed against the plan's at the power they rode: the plan's time for the metres
 * ridden, each interval's answered by its power ratio through its physics, over the time they
 * took, in the last windowS of racing after the first skipS (the interval in progress counts up
 * to planM), shrunk towards 1 by priorS. Above 1 is faster than the plan (a draft, a planner a
 * little off), below slower; 1 with nothing ridden. The finish prediction looks over the whole
 * race; the countdown (countdown.mjs) over its last five minutes.
 */
export function speedAgainstPlan(tracking, intervals, raceS, planM, riderKg, {windowS = Infinity, priorS = SPEED_PRIOR_S, skipS = START_SKIP_S, ratioMin = POWER_RATIO_MIN, ratioMax = POWER_RATIO_MAX, min = SPEED_MIN, max = SPEED_MAX} = {}) {
    const windowStart = Math.max(raceS - windowS, skipS);
    let expected = 0;
    let actual = 0;
    for (const s of tracking.stats) {
        const iv = intervals[s?.index];
        if (!s || !(iv?.lengthM > 0) || !(iv.durationS > 0) || !(s.elapsedS > 0)) {
            continue;
        }
        const endS = s.finished && s.endRaceS != null ? s.endRaceS : raceS;
        const spanS = endS - s.startRaceS;
        const overlap = Math.min(endS, raceS) - Math.max(s.startRaceS, windowStart);
        if (!(spanS > 0) || overlap <= 0) {
            continue;
        }
        const fromM = Math.max(iv.startM, Number.isFinite(s.startPlanM) ? s.startPlanM : iv.startM);
        const toM = s.finished ? iv.endM : Math.min(iv.endM, Number.isFinite(planM) ? planM : fromM);
        if (!(toM > fromM)) {
            continue;
        }
        const planS = timeInto(iv, toM) - timeInto(iv, fromM);
        const ratio = Number.isFinite(s.avgPowerW) && iv.powerW > 0 ? Math.min(ratioMax, Math.max(ratioMin, s.avgPowerW / iv.powerW)) : 1;
        const share = overlap / spanS;
        expected += share * planS * Math.pow(ratio, -timeExponent(iv, riderKg));
        actual += share * s.elapsedS;
    }
    return Math.min(max, Math.max(min, (expected + priorS) / (actual + priorS)));
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

// The metres a second of the interval's own plan covers: its average pace.
function paceOf(iv) {
    return iv.lengthM > 0 && iv.durationS > 0 ? iv.lengthM / iv.durationS : 0;
}

/**
 * Plan time at a plan metre, inside the interval by its time marks (timeInto). Past the plan's
 * last metre (a course can put the finish there) the last interval's pace carries on.
 */
export function planTimeAtMetre(intervals, planM) {
    if (!Number.isFinite(planM) || !intervals.length) {
        return 0;
    }
    if (planM <= intervals[0].startM) {
        return 0;
    }
    for (const iv of intervals) {
        if (planM < iv.endM) {
            return iv.startTimeS + (iv.lengthM > 0 ? timeInto(iv, planM) : iv.durationS);
        }
    }
    const last = intervals.at(-1);
    const pace = paceOf(last);
    return last.endTimeS + (pace > 0 ? (planM - last.endM) / pace : 0);
}

/**
 * The plan's time from planM to finishM, with each interval scaled for the rider's power ratio.
 * Metres past the plan's last one (pastPlan) are at the last interval's pace, scaled alike.
 */
function remainingAtRatio(intervals, planM, finishM, ratio, riderKg) {
    let plan = 0;
    let scaled = 0;
    for (const iv of intervals) {
        const from = Math.max(iv.startM, planM);
        const to = Math.min(iv.endM, finishM);
        if (!(to > from) || !(iv.lengthM > 0)) {
            continue;
        }
        const planS = timeInto(iv, to) - timeInto(iv, from);
        plan += planS;
        scaled += planS * Math.pow(ratio, -timeExponent(iv, riderKg));
    }
    const last = intervals.at(-1);
    const pace = paceOf(last);
    const beyondFrom = Math.max(planM, last.endM);
    if (pace > 0 && finishM > beyondFrom) {
        const extraS = (finishM - beyondFrom) / pace;
        plan += extraS;
        scaled += extraS * Math.pow(ratio, -timeExponent(last, riderKg));
    }
    return {planS: plan, scaledS: scaled};
}

/**
 * Finish prediction from the race clock. planTimeAtStart is the plan time at the metre
 * where the clock started, so a plan from the pen compares with a clock from the line;
 * finishM is where the race ends (the event's distance when it is shorter than the plan).
 * deficitS is the clock against the plan at this metre; the rest is the plan's remaining
 * time at the rider's recent power, at the speed against the plan they have shown. pacing is
 * that power ratio, speed that speed.
 */
export function predict({tracking, plan, index, planM, raceS, planTimeAtStart = 0, finishM = null, pastPlan = false}) {
    const intervals = plan.intervals;
    if (!Number.isFinite(raceS) || !intervals.length) {
        return null;
    }
    // The finish is the event's distance, within the plan; past the plan's end only when the
    // course put it there (pastPlan: the course's own metres, locked).
    const endM = Number.isFinite(finishM) && finishM > 0 ? (pastPlan ? finishM : Math.min(finishM, plan.lengthM)) : plan.lengthM;
    const planTotalS = Math.max(0, planTimeAtMetre(intervals, endM) - planTimeAtStart);
    const here = Number.isFinite(planM) ? Math.min(Math.max(planM, intervals[0].startM), endM) : intervals[0].startM;
    const deficitS = raceS - Math.max(0, planTimeAtMetre(intervals, here) - planTimeAtStart);
    const {ratio, sampleS} = powerRatio(tracking, intervals, raceS);
    const {planS: remainingPlanS, scaledS} = remainingAtRatio(intervals, here, endM, ratio, plan.weightKg);
    const speed = speedAgainstPlan(tracking, intervals, raceS, planM, plan.weightKg);
    const finished = index >= intervals.length || here >= endM;
    const remainingS = finished ? 0 : scaledS / speed;
    const totalS = finished ? raceS : raceS + remainingS;
    return {
        pacing: ratio,
        speed,
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
