// The race clock (docs/REVAMP_PLAN.md 1.2). Three kinds of start, picked from the event:
//
//   tt     a TT event: the clock starts at the timing line. Which telemetry marks it is
//          still to be read off a real recording, so the signal is a rule: 'time'
//          (state.time leaves 0 while in the event; what the old mod relied on and what
//          the synthetic recordings assume), 'distance' (the rider moves past the plan's
//          line metre), or 'auto' (Zwift's own clock first, distance as the fallback).
//   group  a mass-start event: the clock runs from the gun (the subgroup's start time
//          when known, else the first eventDistance above 0).
//   manual a free ride: the clock runs from the arm.
//
// Elapsed seconds come from the telemetry where they can (state.time, state.worldTime)
// so two windows on the same ticks read the same clock.

export const START_RULES = ['auto', 'time', 'distance'];
export const START_DELAY_M = 150;      // the old planner rule: the line 150 m after the pen-to-route metres
export const DEFAULT_PEN_M = 30;
const MAX_BACKDATE_S = 10;

export function createClock() {
    return {running: false, signal: null, startWorldMs: null, startPlanM: null, elapsedS: 0};
}

/**
 * The timing line in plan metres. Plan files from the 2026-10-27 planner say where the clock
 * starts (route.start_line_m: 0, the pen, on most routes; ZwiftPower's time is the ride from
 * the pen). Older files were built on the 150 m start delay after the pen-to-route metres.
 */
export function lineMetre(plan) {
    if (Number.isFinite(plan?.startLineM)) {
        return plan.startLineM;
    }
    return (plan?.startOffsetM ?? DEFAULT_PEN_M) + START_DELAY_M;
}

/**
 * Advance the clock with a tick. kind: 'tt' | 'group' | 'manual'. Returns the clock with
 * `justStarted` set on the tick that started it.
 */
export function advanceClock(clock, {kind, rule = 'auto', prev, tick, plan, planM, eventStartMs = null, armedWorldMs = null}) {
    const worldMs = worldTimeOf(tick);
    const timeS = Number(tick?.state?.time);
    const out = {...clock, justStarted: false};
    if (!out.running) {
        let signal = null;
        if (kind === 'tt') {
            const prevTime = Number(prev?.state?.time);
            const timeRose = Number.isFinite(timeS) && timeS > 0 && (!prev || !(prevTime > 0));
            const timeKnown = Number.isFinite(timeS) && timeS > 0;
            if ((rule === 'auto' || rule === 'time') && (timeRose || (!prev && timeKnown))) {
                signal = 'time';
            } else if ((rule === 'auto' || rule === 'distance') && Number.isFinite(planM) && planM > lineMetre(plan)
                && Number(tick?.state?.eventDistance) > 0) {
                // Moving past the line: with the line at the pen (metre 0) a rider waiting in
                // the pen has not started, whatever the offset.
                signal = 'distance';
            }
        } else if (kind === 'group') {
            if (Number.isFinite(eventStartMs) && worldMs != null && worldMs >= eventStartMs) {
                signal = 'gun';
            } else if (Number(tick?.state?.eventDistance) > 0) {
                signal = 'distance';
            }
        } else if (kind === 'manual' && armedWorldMs != null) {
            signal = 'manual';
        }
        if (!signal) {
            return out;
        }
        out.running = true;
        out.justStarted = true;
        out.signal = signal;
        out.startPlanM = Number.isFinite(planM) ? planM : null;
        out.startWorldMs = signal === 'gun' ? eventStartMs : signal === 'manual' ? armedWorldMs : worldMs;
        if (signal === 'time') {
            out.startWorldMs = worldMs != null ? worldMs - timeS * 1000 : null;
        } else if (signal === 'distance') {
            // Back to the moment the rider crossed the line, from the metres past it.
            const line = lineMetre(plan);
            const speedMs = (Number(tick?.state?.speed) || 0) / 3.6;
            const pastS = speedMs > 0 ? Math.min(MAX_BACKDATE_S, (planM - line) / speedMs) : 0;
            out.startWorldMs = worldMs != null ? worldMs - pastS * 1000 : null;
            out.startPlanM = line;
        }
    }
    out.elapsedS = elapsedOf(out, tick, worldMs);
    return out;
}

function elapsedOf(clock, tick, worldMs) {
    const timeS = Number(tick?.state?.time);
    if (clock.signal === 'time' && Number.isFinite(timeS) && timeS > 0) {
        return timeS;
    }
    if (worldMs != null && clock.startWorldMs != null) {
        return Math.max(0, (worldMs - clock.startWorldMs) / 1000);
    }
    return clock.elapsedS;
}

/** The tick's time base in ms: Zwift's world time when present, else the wall clock given. */
export function worldTimeOf(tick, fallbackMs = null) {
    const w = Number(tick?.state?.worldTime);
    return Number.isFinite(w) && w > 0 ? w : fallbackMs;
}
