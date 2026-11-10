// Time left in the interval: a clock that counts down a second a second and settles on
// when the rider will reach the power change (Dave, 2026-11-10). It was the metres to the
// change over the speed of the moment, so a hill inside an interval made it leap (half
// the speed, twice the seconds) and a crest made it collapse: on four recorded TTs a
// fifth of its ticks went up or dropped three seconds or more.
//
// The estimate is the plan's time for the metres left in the interval (the planner timed
// the interval's terrain), answered by:
//   - the rider's power in this interval against its target: the interval's average so
//     far, leaning on the target until there is half a minute of it (a dip of a few
//     seconds is not the rest of a climb), through the interval's physics;
//   - the rider's speed against the plan's at the power they rode, over the last five
//     minutes (a draft, a planner a little off), leaning on the plan's for the first one.
// The shown figure counts down in real time and eases onto the estimate.
//
// Back-test (2026-11-10): four recorded TTs (TT/fixtures/rides in the planner) with plans
// optimised for them, every tick against when the interval really ended. Mean error 12.7 s
// → 6.1 s; ticks where the figure went up or dropped 3 s or more 21 % → under 1 %. Ridden
// 20 % faster than recorded (a draft): 10.6 s → 8.6 s, where the plan's time alone is 26.5 s
// out. What is left is mostly terrain inside long intervals: the file has each interval's
// time, not where in it the time goes (a climb at the end of a flat interval).
// Pure: the engine feeds it the race clock.

import {timeInto} from './plan.mjs';
import {timeExponent} from './tracking.mjs';

export const POWER_PRIOR_S = 30;    // the interval's power counts for half after this much of it
export const POWER_GRACE_S = 3;     // not its first seconds: the rider is still changing power
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 1.5;
export const SPEED_WINDOW_S = 300;  // the rider's speed against the plan's, over this much racing
export const SPEED_PRIOR_S = 60;    // and counting for half after this much of it
export const SPEED_MIN = 0.6;
export const SPEED_MAX = 1.6;
export const EASE_S = 4;            // the shown figure eases onto the estimate over this (less near the change)
export const SNAP_GAP_S = 5;        // a gap in the ticks longer than this: show the estimate as it is

export function createCountdown() {
    return {index: null, startS: null, lastS: null, ratioS: 0, ratioSumS: 0, shownS: null};
}

/**
 * The rider's speed against the plan's at the power they rode, over the last
 * SPEED_WINDOW_S of racing (the interval in progress counts up to planM): above 1 is
 * faster than the plan (a draft), below slower; 1 with nothing ridden.
 */
export function speedFactor(tracking, intervals, raceS, planM, riderKg) {
    const windowStart = raceS - SPEED_WINDOW_S;
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
        const planS = planSeconds(iv, fromM, toM);
        const ratio = Number.isFinite(s.avgPowerW) && iv.powerW > 0 ? clamp(s.avgPowerW / iv.powerW, RATIO_MIN, RATIO_MAX) : 1;
        const share = overlap / spanS;
        expected += share * planS * Math.pow(ratio, -timeExponent(iv, riderKg));
        actual += share * s.elapsedS;
    }
    return clamp((expected + SPEED_PRIOR_S) / (actual + SPEED_PRIOR_S), SPEED_MIN, SPEED_MAX);
}

/**
 * One tick on the race clock, in interval index at planM. Returns {leftS, estimateS,
 * ratio, speed}, or null outside the plan's intervals (and then forgets the interval).
 */
export function advanceCountdown(cd, {intervals, index, planM, raceS, power, tracking, riderKg}) {
    const iv = index >= 0 && index < intervals.length ? intervals[index] : null;
    if (!iv || !Number.isFinite(raceS) || !Number.isFinite(planM)) {
        Object.assign(cd, createCountdown());
        return null;
    }
    const dt = cd.lastS == null ? 0 : raceS - cd.lastS;
    if (cd.index !== index) {
        Object.assign(cd, createCountdown(), {index, startS: raceS});
    }
    // The power against this interval's target, from its first few seconds on.
    if (dt > 0 && Number.isFinite(power) && iv.powerW > 0 && raceS - cd.startS >= POWER_GRACE_S) {
        cd.ratioSumS += clamp(power / iv.powerW, RATIO_MIN, RATIO_MAX) * dt;
        cd.ratioS += dt;
    }
    const ratio = (POWER_PRIOR_S + cd.ratioSumS) / (POWER_PRIOR_S + cd.ratioS);
    const speed = speedFactor(tracking, intervals, raceS, planM, riderKg);
    const planLeftS = planSeconds(iv, Math.max(iv.startM, planM), iv.endM);
    const estimateS = planLeftS * Math.pow(ratio, -timeExponent(iv, riderKg)) / speed;
    if (cd.shownS == null || dt < 0 || dt > SNAP_GAP_S) {
        cd.shownS = estimateS;
    } else if (dt > 0) {
        // A second a second, eased onto the estimate; quicker near the change.
        const counted = cd.shownS - dt;
        const ease = clamp(estimateS / 4, 0.5, EASE_S);
        cd.shownS = Math.max(0, counted + (1 - Math.exp(-dt / ease)) * (estimateS - counted));
    }
    cd.lastS = raceS;
    return {leftS: cd.shownS, estimateS, ratio, speed};
}

/** The plan's seconds between two metres of an interval: by its time marks, else at its average speed. */
function planSeconds(iv, fromM, toM) {
    return iv.lengthM > 0 && toM > fromM ? timeInto(iv, toM) - timeInto(iv, fromM) : 0;
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
