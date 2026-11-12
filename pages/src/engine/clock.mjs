import {lineInPlanM} from './align.mjs';
// The race clock (docs/REVAMP_PLAN.md 1.2). Three kinds of start, picked from the event:
//
//   tt     a TT event: the clock starts at the timing line. Which telemetry marks it is
//          still to be read off a real recording, so the signal is a rule: 'time'
//          (state.time leaves 0 while in the event; what the old mod relied on and what
//          the synthetic recordings assume), 'distance' (the rider moves past the plan's
//          line metre), or 'auto' (Zwift's own clock first, distance as the fallback).
//   group  a mass-start event: the game's distance and timer start at a timing line too (102 m
//          out of the pen on the Watopia Hilly Route, 19 s after the gun: race 5780317,
//          2026-11-11), and the plan starts there, so this clock starts at the line as a TT's
//          does. The result counts from the gun: the engine adds the seconds from the gun to
//          the line (gunToLineS) for the official time.
//   manual a free ride: the clock runs from the arm.
//   here   a plan from here: the clock runs from the moment it was asked for (its anchor).
//
// Elapsed seconds come from the telemetry where they can (state.time, state.worldTime)
// so two windows on the same ticks read the same clock.

export const START_RULES = ['auto', 'time', 'distance'];
const MAX_BACKDATE_S = 10;
// Zwift's world time (state.worldTime) is milliseconds from this moment; an event's start time
// from Sauce is Unix milliseconds. A world time is below 1e12 until 2046, a Unix time above it.
export const ZWIFT_EPOCH_MS = 1414016074400;
export const MAX_GUN_TO_LINE_S = 300;
const LINE_AGREES_MS = 2000;        // the crossing seen and Zwift's whole-second timer agree within this

/** A world time as Unix milliseconds (a value already on the Unix scale is returned as it is). */
export function worldToUnixMs(worldMs) {
    const w = Number(worldMs);
    if (worldMs == null || !Number.isFinite(w)) {
        return null;
    }
    return w < 1e12 ? w + ZWIFT_EPOCH_MS : w;
}

/** A Unix time on the scale a tick's world time is on (Zwift's, or Unix in a synthetic recording). */
export function unixToWorldMs(unixMs, sampleWorldMs) {
    const u = Number(unixMs);
    const w = Number(sampleWorldMs);
    if (unixMs == null || !Number.isFinite(u) || sampleWorldMs == null || !Number.isFinite(w)) {
        return null;
    }
    return w < 1e12 && u >= 1e12 ? u - ZWIFT_EPOCH_MS : u;
}

/**
 * The seconds from a mass start's gun to the rider's crossing of the timing line (the clock's
 * lineWorldMs), or null when either is not known or the answer is not a start (a late join, a
 * clock out of step).
 */
export function gunToLineS(clock, eventStartMs) {
    const lineMs = clock?.lineWorldMs ?? null;
    const gunMs = unixToWorldMs(eventStartMs, lineMs);
    if (!clock?.running || lineMs == null || gunMs == null) {
        return null;
    }
    const s = (lineMs - gunMs) / 1000;
    return s >= 0 && s <= MAX_GUN_TO_LINE_S ? s : null;
}

export function createClock() {
    return {running: false, signal: null, startWorldMs: null, lineWorldMs: null, startPlanM: null, elapsedS: 0};
}

/**
 * The timing line in plan metres. Plan files from the 2026-10-27 planner say where the clock
 * starts (route.start_line_m: 0, the pen, on most routes; ZwiftPower's time is the ride from
 * the pen). Older files were built on the 150 m start delay after the pen-to-route metres.
 */
export function lineMetre(plan, tick = null) {
    // The plan metre where the clock starts: from the event's length, else the file (align.mjs).
    return lineInPlanM(tick, plan);
}

/**
 * Advance the clock with a tick. kind: 'tt' | 'group' | 'manual' | 'here'. Returns the clock with
 * `justStarted` set on the tick that started it. lineM is the timing line in plan metres at this
 * tick (the course's implied line once locked, else the rule's); it defaults to lineMetre(plan, tick).
 * lineWorldMs is when the rider crossed the line: from the event metres past it when the crossing
 * was seen (finer than the game's whole-second timer), else from the timer; null when neither
 * says (a window opened mid-race with no timer: the clock then starts late and is not a result).
 */
export function advanceClock(clock, {kind, rule = 'auto', prev, tick, plan, planM, armedWorldMs = null, lineM = null}) {
    const worldMs = worldTimeOf(tick);
    const timeS = Number(tick?.state?.time);
    const line = Number.isFinite(lineM) ? lineM : lineMetre(plan, tick);
    const out = {...clock, justStarted: false};
    if (!out.running) {
        let signal = null;
        if (kind === 'tt' || kind === 'group') {
            const prevTime = Number(prev?.state?.time);
            const timeRose = Number.isFinite(timeS) && timeS > 0 && (!prev || !(prevTime > 0));
            const timeKnown = Number.isFinite(timeS) && timeS > 0;
            if ((rule === 'auto' || rule === 'time') && (timeRose || (!prev && timeKnown))) {
                signal = 'time';
            } else if ((rule === 'auto' || rule === 'distance') && Number.isFinite(planM) && planM > line
                && Number(tick?.state?.eventDistance) > 0) {
                // Moving past the line: with the line at the pen (metre 0) a rider waiting in
                // the pen has not started, whatever the offset.
                signal = 'distance';
            }
        } else if (kind === 'manual' && armedWorldMs != null) {
            signal = 'manual';
        } else if (kind === 'here' && armedWorldMs != null) {
            signal = 'here';
        }
        if (!signal) {
            return out;
        }
        out.running = true;
        out.justStarted = true;
        out.signal = signal;
        out.startPlanM = signal === 'here' ? 0 : (Number.isFinite(planM) ? planM : null);
        out.startWorldMs = (signal === 'manual' || signal === 'here') ? armedWorldMs : worldMs;
        if (signal === 'time' || signal === 'distance') {
            // When the line was crossed: the event metres ridden since, at this speed. Only for a
            // crossing just seen: a window opened mid-race sees the rider far past the line.
            const edM = Number(tick?.state?.eventDistance);
            const speedMs = (Number(tick?.state?.speed) || 0) / 3.6;
            const pastS = edM > 0 && speedMs > 0 ? edM / speedMs : null;
            out.lineWorldMs = worldMs != null && pastS != null && pastS < MAX_BACKDATE_S ? worldMs - pastS * 1000 : null;
        }
        if (signal === 'time') {
            // Zwift's clock started at the line, whatever metre the rider is at now: the plan
            // time at the start is the line's (the course re-anchors it if the line moves).
            out.startWorldMs = worldMs != null ? worldMs - timeS * 1000 : null;
            out.startPlanM = line;
            // Zwift's timer says when the line was crossed, to the second: it stands when no
            // crossing was seen (a window opened mid-race) or the one seen is not this one. The
            // timer shows whole seconds done, so the crossing is half a second earlier on average.
            if (out.startWorldMs != null && (out.lineWorldMs == null || Math.abs(out.lineWorldMs - out.startWorldMs) > LINE_AGREES_MS)) {
                out.lineWorldMs = out.startWorldMs - 500;
            }
        } else if (signal === 'distance') {
            // Back to the moment the rider crossed the line, from the metres past it.
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
