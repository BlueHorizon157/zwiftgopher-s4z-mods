// The one engine (docs/REVAMP_PLAN.md 1.7): plan + telemetry + controls in, a view model
// out. Pure: no DOM, no storage, no timers; the window feeds ticks and the wall clock in.
// Every window runs its own copy on the same ticks and reaches the same numbers.
//
//   const engine = createEngine({plan, prefs});
//   engine.tick(athleteData, nowMs);   // each 'athlete/watching'
//   engine.view();                     // what to draw
//   engine.control('offsetM', 20); engine.event('reset'); engine.event('eventInfo', {...})
//
// States: idle (no plan or rider) → armed (plan and rider, stats clear) → racing (clock
// running) → finished. Spectating is a flag over any state: ticks of another rider are
// ignored. Only an explicit event, a new event subgroup, or the rider back in the event's pen
// clears statistics.
//
// Joining an event from a free ride, Sauce gives the subgroup a few ticks before Zwift moves the
// rider to the pen: those ticks still carry the warm-up's road, distance and timer (2026-11-18:
// 12.8 km and 26 minutes in, which 0.9.6 took for a race 12.8 km along). So after the subgroup
// arrives nothing is placed or started until the rider is seen at the start (align.mjs
// atEventStart). And a race whose rider is back at the start for PEN_HOLD_MS is armed again.
// The wait is not for ever (2026-11-26 audit): a rider who joins a race in progress, or whose
// subgroup drops out and returns, is never seen at the start. It ends when the ticks show
// another course than the one the join began on, or after JOIN_WAIT_MS; and the same subgroup
// back within REJOIN_MS is the same race, not a join.
//
// A plan from here (plan.fromHere: views/from-here.mjs) belongs to the moment it was asked
// for: it races at once from its anchor while the rider is still in that event, or on that
// route outside one, and once they leave it is spent (idle) and never arms anywhere else.

import {normalisePlan} from './plan.mjs';
import {locate, at, boundary, BEFORE} from './cursor.mjs';
import {createClock, advanceClock, worldTimeOf, gunToLineS} from './clock.mjs';
import {inEvent, subgroupOf, atEventStart, routeMatches, planMetre, rideDistanceM, mismatchM, eventLengthM, raceLengthM, eventLengthFor, eventDistanceM, distanceToGoM, lineInPlanM, alignmentOf, numberOrNull, OUT_OF_STEP_M} from './align.mjs';
import {createTracking, advance, closeInterval, shiftStarts, predict, planTimeAtMetre} from './tracking.mjs';
import {createCourseTracker, advanceCourse, courseMetre, maxStepM} from './course.mjs';
import {update as wbalUpdate} from './wbal.mjs';
import {createCountdown, advanceCountdown} from './countdown.mjs';

export const DEFAULT_PREFS = {
    smoothingSec: 3,
    bandWidthW: 5,
    startRule: 'auto',      // clock.mjs START_RULES
};

export const DEFAULT_CONTROLS = {
    offsetM: 0,
    bias: 1,
};

const OUT_OF_STEP_MOVE_M = 25;      // the kept out-of-step figure moves only for a line this far from it
// A racing rider at the start of the event this long (Zwift's world time) is back in the pen: a
// rejoin, or a clock started by mistake. Longer than one stray tick; the pen's own ticks can be
// 17 s apart while Zwift loads the course.
export const PEN_HOLD_MS = 2000;
// Joined and never seen at the start: the ticks are taken as the race's after this long. The Fan
// Flats warm-up ticks (2026-11-18) were 3 s of the subgroup and then 17 s of nothing before the
// pen, so they are over long before this; and if a stale tick did get through, the pen arms the
// race again (PEN_HOLD_MS).
export const JOIN_WAIT_MS = 30000;
// The same subgroup seen again this soon after it was lost is the same race.
export const REJOIN_MS = 20000;
// A finish by Sauce's distance to go counts when the rider's event distance is this near the
// event's length: Sauce's remaining is the length less the event distance, so a real finish
// always is, and a stray reading of 0 in the middle of the race is not.
export const FINISH_SLACK_M = 50;
// The file a plan came from, apart from its intervals (the signature): the course, the finish, the
// timing line, CP and W'. A plan sent again with the same intervals and these changed (after the
// planner's update, or the rider's numbers) is not the plan already loaded (2026-11-26 audit).
const inputsOf = p => `${p.course ? `${p.course.count}:${p.course.m[p.course.count - 1]}` : 0}|${p.startLineM}|${p.finishM}|${p.finishSource}|${p.cp}|${p.wPrimeJ}`;
const samePlan = (a, b) => a?.signature === b?.signature && (!a || inputsOf(a) === inputsOf(b));
// The alignment for the view: on the course, the out-of-step figure is the kept one.
const alignmentWith = (a, keptStepM) => (a.mode === 'course' ? {...a, outOfStepM: keptStepM ?? null} : a);
// The course tracker of a plan, for a race in an event (course.mjs); none for a free ride or a
// plan from here, or a plan without a sound course.
const courseFor = p => p && !p.fromHere && p.course ? createCourseTracker(p.course, {routeMPerGameM: p.routeMPerGameM}) : null;

export function createEngine({plan = null, prefs = {}, controls = {}} = {}) {
    const initial = plan && plan.intervals && plan.signature ? plan : normalisePlan(plan);
    const state = {
        plan: initial,
        prefs: {...DEFAULT_PREFS, ...prefs},
        controls: {...DEFAULT_CONTROLS, ...controls},
        status: 'idle',
        home: null,
        spectating: null,
        event: {subgroupId: null, kind: null, startMs: null, name: null, infoFor: null},
        anchorDistanceM: null,
        armedWorldMs: null,
        clock: createClock(),
        tracking: createTracking(),
        course: courseFor(initial),
        courseLoggedDiff: false,
        finishS: null,
        lastRacePoint: null,
        index: BEFORE,
        displayIndex: BEFORE,
        planM: null,
        planTimeAtStart: 0,
        wbalJ: null,
        wbalLastMs: null,
        ema: null,
        emaMs: null,
        prevTick: null,
        tick: null,
        tickMs: null,
        lastPrediction: null,
        countdown: createCountdown(),
        left: null,
        hereSpent: false,
        // A mass start's seconds from the gun to the timing line (clock.mjs gunToLineS): null in a
        // TT, a free ride, or when not known. Kept once known, through the finish and after it.
        gunS: null,
        // How far the plan's timing line is from the one the road gives (align.mjs alignmentOf),
        // kept at the figure first found: the matched line wanders a few metres with the
        // rider's line through the bends, and the HUD's words should not.
        outOfStepM: null,
        // Joined an event and not yet seen at its start: the ticks may still be the free ride's.
        joining: false,
        // The world time the join began, the course the rider was on then, and the last subgroup
        // seen with its world time (a subgroup back within REJOIN_MS is no join).
        joinSinceMs: null,
        joinCourseId: null,
        lastInEvent: null,
        // The subgroup the rider finished in, then cleared the race (Reset, a plan loaded): the
        // timer keeps running and the distance to go stays spent after the finish, so the next
        // race starts only at a real start (the pen, or another event), never on the old timer.
        afterFinish: null,
        // The world time the rider was first seen at the start of the event, in a row of such ticks.
        atStartSinceMs: null,
        // The clock was cleared and has not started since: in an event its first start may take
        // Zwift's race timer as it stands (a reset or a plan loaded mid-race), not only a timer
        // seen leaving zero.
        clockFresh: true,
        log: [],
    };

    const log = (msg, nowMs) => {
        state.log.push({t: nowMs ?? Date.now(), msg});
        if (state.log.length > 200) {
            state.log.shift();
        }
    };

    const clearRace = (why, nowMs) => {
        state.clock = createClock();
        state.tracking = createTracking();
        state.course = courseFor(state.plan);
        state.courseLoggedDiff = false;
        state.finishS = null;
        state.lastRacePoint = null;
        state.index = BEFORE;
        state.displayIndex = BEFORE;
        state.planTimeAtStart = 0;
        state.wbalJ = state.plan?.wPrimeJ ?? null;
        state.wbalLastMs = null;
        state.lastPrediction = null;
        state.countdown = createCountdown();
        state.left = null;
        state.armedWorldMs = null;
        state.anchorDistanceM = null;
        state.gunS = null;
        state.outOfStepM = null;
        state.clockFresh = true;
        log(`Statistics cleared: ${why}`, nowMs);
    };

    // A mass start: the result counts from the gun, the clock from the line (clock.mjs). Looked
    // for on each tick and when the event's kind and start arrive, which can be after the clock
    // has started (a window opened mid-race) or after the finish.
    const noteGun = nowMs => {
        if (state.gunS != null || !state.plan || state.plan.fromHere || !state.clock.running
            || state.event.kind !== 'group' || !inEvent(state.tick)) {
            return;
        }
        const gunS = gunToLineS(state.clock, state.event.startMs);
        if (gunS != null) {
            state.gunS = gunS;
            log(`Mass start: the timing line was crossed ${gunS.toFixed(1)} s after the gun; the result counts from the gun`, nowMs);
        }
    };

    const setStatus = (status, nowMs) => {
        if (state.status !== status) {
            log(`${state.status} → ${status}`, nowMs);
            state.status = status;
        }
    };

    function tick(data, nowMs = Date.now()) {
        if (!data || typeof data !== 'object') {
            return;
        }
        const athleteId = idOf(data);
        // Home rider: the user's own rider wins; otherwise the first rider seen.
        if (data.self === true && athleteId && state.home !== athleteId) {
            state.home = athleteId;
        } else if (!state.home && athleteId) {
            state.home = athleteId;
        }
        if (state.home && athleteId && athleteId !== state.home) {
            state.spectating = {athleteId, name: nameOf(data)};
            return;
        }
        state.spectating = null;
        const dtS = state.tickMs != null ? (nowMs - state.tickMs) / 1000 : null;
        state.prevTick = state.tick;
        state.tick = data;
        state.tickMs = nowMs;

        // Joining an event (the header): from a change of subgroup seen between two of the rider's
        // ticks until the rider is at the start. Kept with or without a plan, so a plan loaded
        // meanwhile waits too. A tick replayed for a new plan is its own previous one: no change.
        const wasJoining = state.joining;
        const startNow = atEventStart(data);
        const sgNow = subgroupOf(data);
        const worldMs = worldTimeOf(data, nowMs);
        const courseId = numberOrNull(data.state?.courseId);
        if (!sgNow || startNow) {
            state.joining = false;
        } else if (state.prevTick && subgroupOf(state.prevTick) !== sgNow) {
            const back = state.lastInEvent?.sg === sgNow && worldMs >= state.lastInEvent.worldMs && worldMs - state.lastInEvent.worldMs <= REJOIN_MS;
            if (!back) {
                state.joining = true;
                state.joinSinceMs = worldMs;
                state.joinCourseId = courseId;
            }
        } else if (state.joining && (worldMs - state.joinSinceMs >= JOIN_WAIT_MS || (courseId != null && state.joinCourseId != null && courseId !== state.joinCourseId))) {
            // Not at the start after all this time, or the world has changed since the join (the
            // stale ticks carry the warm-up's course): the rider joined a race in progress.
            state.joining = false;
        }
        if (sgNow && !state.joining) {
            state.lastInEvent = {sg: sgNow, worldMs};
        }
        if (state.afterFinish != null && (!sgNow || startNow || sgNow !== state.afterFinish)) {
            state.afterFinish = null;
        }
        state.atStartSinceMs = startNow ? (state.atStartSinceMs ?? worldMs) : null;

        const plan = state.plan;
        if (!plan) {
            setStatus('idle', nowMs);
            smoothPower(data, nowMs);
            return;
        }

        const eventNow = inEvent(data);
        if (plan.fromHere) {
            if (!hereInPlace(data, nowMs, plan)) {
                smoothPower(data, nowMs);
                return;
            }
        } else {
            // Event changes clear the race.
            // Zwift reports no event as 0 or nothing: both are no event here.
            const subgroupId = (data.state?.eventSubgroupId ?? data.eventSubgroupId) || null;
            if (subgroupId !== state.event.subgroupId && state.status === 'finished' && !subgroupId) {
                // Left the event after the finish: the result stays until a new event or a reset
                // (the finished latch; Dave, 2026-11-10: Zwift drops the subgroup a few minutes on).
                state.event = {...state.event, subgroupId: null};
                log('Left the event after the finish: the result is kept', nowMs);
            } else if (subgroupId !== state.event.subgroupId) {
                if (state.status !== 'idle') {
                    clearRace(subgroupId ? `event ${subgroupId}` : 'left the event', nowMs);
                }
                // What Sauce said of this event stays when it came before the subgroup was seen here
                // (the rider had no plan then: the engine only follows the event with one). The
                // subgroup is a number on a tick and a string in the info.
                const known = subgroupId && String(state.event.infoFor) === String(subgroupId);
                state.event = {subgroupId, kind: known ? state.event.kind : null, startMs: known ? state.event.startMs : null, name: known ? state.event.name : null, infoFor: subgroupId ? state.event.infoFor : null};
                if (!subgroupId) {
                    // Left the event: idle, so the plan arms on its route below as on any free ride.
                    setStatus('idle', nowMs);
                } else if (state.status === 'racing' || state.status === 'finished') {
                    setStatus('armed', nowMs);
                }
            }

            if (state.status === 'idle') {
                if (eventNow || routeMatches(data, plan)) {
                    clearRace('ready', nowMs);
                    if (!eventNow) {
                        state.anchorDistanceM = rideDistanceM(data);
                        state.armedWorldMs = worldTimeOf(data, nowMs);
                    }
                    setStatus('armed', nowMs);
                }
            }

            if (state.joining && !wasJoining) {
                log(`Joined event ${sgNow}: waiting until Zwift puts you in the pen`, nowMs);
            } else if (wasJoining && !state.joining && startNow) {
                log('In the pen: the clock starts at the timing line', nowMs);
            }
            // Back at the start while racing (Dave, 2026-11-18: detect the pen): the race so far
            // was not this start's, so it is cleared and armed for the line.
            if (state.status === 'racing' && eventNow && state.atStartSinceMs != null && worldMs - state.atStartSinceMs >= PEN_HOLD_MS) {
                clearRace('back at the start of the event (in the pen)', nowMs);
                setStatus('armed', nowMs);
            }
        }
        // Joined, not yet at the start: the tick is still the free ride's, so nothing is placed,
        // matched or started (a plan from here looks after itself: hereInPlace).
        const waiting = (state.joining || state.afterFinish != null) && !plan.fromHere;

        // The course (course.mjs): in an event, the rider's position is matched on the plan's own
        // course; until it locks, the old rule places the rider.
        // Once finished the course is not fed: the metre stays where the finish put it.
        const fed = !plan.fromHere && eventNow && !waiting && state.course != null && state.status !== 'finished';
        if (fed) {
            const s = data.state ?? {};
            advanceCourse(state.course, {lat: Number(s.latlng?.[0]), lng: Number(s.latlng?.[1]), eventM: eventDistanceM(data), lineHintM: lineInPlanM(data, plan), dtS});
            if (state.course.justLocked) {
                log(`Course matched: the timing line is ${Math.round(state.course.lineM)} m into the plan`, nowMs);
            }
            if (state.course.justUnlocked) {
                log('Course lost: the plan metre runs on from the last match until the road is found again', nowMs);
            }
            const fileLineM = plan.startLineM ?? 0;
            if (state.course.locked && !state.courseLoggedDiff && Math.abs(state.course.lineM - fileLineM) > 20) {
                state.courseLoggedDiff = true;
                log(`Course line ${Math.round(state.course.lineM)} m differs from the file's ${Math.round(fileLineM)} m`, nowMs);
            }
            // The plan out of step with the race: the figure is kept as first found, and moves
            // only when the road gives a line somewhere else again (a second lock).
            if (state.course.locked && Number.isFinite(state.course.lineM)) {
                const stepM = state.course.lineM - lineInPlanM(data, plan);
                const moved = state.outOfStepM == null ? Math.abs(stepM) >= OUT_OF_STEP_M : Math.abs(stepM - state.outOfStepM) > OUT_OF_STEP_MOVE_M;
                if (moved) {
                    state.outOfStepM = Math.abs(stepM) >= OUT_OF_STEP_M ? stepM : null;
                    if (state.outOfStepM != null) {
                        log(`Plan out of step with the race: the road puts the timing line ${Math.round(Math.abs(stepM))} m ${stepM > 0 ? 'after' : 'before'} where the plan has it; the targets follow the road`, nowMs);
                    }
                }
            }
        }
        // The course's metre: locked on the road, or carried on the odometer after a loss (course.mjs).
        const courseLocked = !plan.fromHere && eventNow && state.course?.locked === true;
        const courseTracked = !plan.fromHere && eventNow && courseMetre(state.course) != null;
        const courseJustLocked = fed && state.course.justLocked;
        const lineM = courseTracked && state.course.lineM != null ? state.course.lineM : lineInPlanM(data, plan);
        const planM = waiting ? null : planMetre(data, {offsetM: state.controls.offsetM, anchorDistanceM: state.anchorDistanceM, plan, courseM: courseTracked ? courseMetre(state.course) : null});
        state.planM = planM;
        smoothPower(data, nowMs);
        if (state.status === 'idle' || waiting) {
            return;
        }

        // The clock.
        const kind = plan.fromHere ? 'here' : eventNow ? (state.event.kind ?? 'tt') : 'manual';
        const clock = advanceClock(state.clock, {
            kind,
            rule: state.prefs.startRule,
            // A cleared clock in an event starts on Zwift's race timer as it stands (a reset, or a
            // plan loaded mid-race), as a window opened mid-race does: never a free ride's timer,
            // as nothing starts while joining.
            prev: state.clockFresh ? null : state.prevTick,
            tick: data,
            plan,
            planM,
            armedWorldMs: plan.fromHere ? plan.fromHere.worldMs : state.armedWorldMs,
            lineM,
        });
        state.clock = clock;
        if (clock.justStarted) {
            state.clockFresh = false;
            state.planTimeAtStart = planTimeAtMetre(plan.intervals, clock.startPlanM ?? 0);
            // A plan from here starts with the W' the ride so far left (the planner's replay).
            state.wbalJ = plan.fromHere?.startWbalJ ?? plan.wPrimeJ;
            state.wbalLastMs = worldTimeOf(data, nowMs);
            setStatus('racing', nowMs);
            log(`Clock started (${clock.signal}) at plan metre ${Math.round(clock.startPlanM ?? 0)}`, nowMs);
        }
        noteGun(nowMs);
        // The clock started at the line before the course found it (Zwift's time, or the event
        // distance from the line): the plan time at the start is the line's, now the line is known.
        if (courseJustLocked && state.clock.running && (state.clock.signal === 'time' || state.clock.signal === 'distance')) {
            // The first lock: the intervals begun so far were placed on the old rule's metres.
            if (state.course.locks === 1 && Number.isFinite(state.clock.startPlanM)) {
                shiftStarts(state.tracking, lineM - state.clock.startPlanM);
            }
            state.clock = {...state.clock, startPlanM: lineM};
            state.planTimeAtStart = planTimeAtMetre(plan.intervals, lineM);
        }

        // The cursor, the statistics, the prediction, the W'.
        const power = numberOrNull(data.state?.power) ?? NaN;
        const rawIndex = planM == null ? state.index : locate(plan.intervals, planM, state.index);
        // With the event's length known, the race ends at the finish, not the plan's end: past
        // the plan's last boundary the last interval stays the target and is ridden on.
        const sauceLength = raceLengthM(data) != null;
        // A measured course ends at the finish (courseFinishM): with the course locked the race
        // ends there, whatever Sauce's event length says.
        const courseEndM = courseLocked ? courseFinishM(plan, data) : null;
        const index = (sauceLength || courseEndM != null) && rawIndex >= plan.intervals.length ? plan.intervals.length - 1 : rawIndex;
        const speedMs = (Number(data.state?.speed) || 0) / 3.6;
        // The shown interval is the one the rider is in: the target switches at the boundary,
        // when the countdown reaches zero (Dave, 2026-10-27). The plan's boundaries are the
        // optimum (REVAMP_PLAN 6.3), so nothing here anticipates them.
        state.displayIndex = index;
        if (state.status === 'racing' && clock.running && planM != null) {
            const before = state.tracking.lastIndex;
            // A boundary crossed between two ticks was crossed in between, not at this tick: with
            // a gap in the ticks (a dropout, a stall) the whole gap went to the interval left, whose
            // metres were counted in full, and the rider looked slow by the length of the gap for
            // minutes (2026-11-26 audit: a 6 s gap over the first boundary of Crit Cross put the
            // prediction 24 s out). Not timed by when the metre moved by itself (the course's lock)
            // or further than any rider rides in the time.
            const lp = state.lastRacePoint;
            if (!courseJustLocked && before != null && before >= 0 && index > before && lp && Number.isFinite(lp.planM) && planM > lp.planM) {
                const dtS = clock.elapsedS - lp.raceS;
                if (dtS > 0 && planM - lp.planM <= maxStepM(dtS)) {
                    for (let j = before; j < index && j < plan.intervals.length; j++) {
                        const boundaryM = plan.intervals[j].endM;
                        const share = Math.min(1, Math.max(0, (boundaryM - lp.planM) / (planM - lp.planM)));
                        advance(state.tracking, {
                            index: j + 1,
                            raceS: lp.raceS + share * dtS,
                            power: Number.isFinite(power) ? power : null,
                            planM: boundaryM,
                            intervals: plan.intervals,
                            atStart: false,
                            startLineM: lineM,
                        });
                    }
                }
            }
            advance(state.tracking, {
                index,
                raceS: clock.elapsedS,
                power: Number.isFinite(power) ? power : null,
                planM,
                intervals: plan.intervals,
                atStart: clock.justStarted,
                startLineM: lineM,
            });
            state.index = index;
            const prevPrediction = state.lastPrediction;
            const completed = state.tracking.stats.filter(s => s?.finished).length;
            // Re-predict when an interval completes, on the first tick, and once a second otherwise.
            if (!prevPrediction || prevPrediction.completed !== completed || clock.elapsedS - prevPrediction.raceS >= 1) {
                const p = predict({tracking: state.tracking, plan, index, planM, raceS: clock.elapsedS, planTimeAtStart: state.planTimeAtStart, finishM: finishMetre(data, plan, planM, courseTracked ? state.course : null), pastPlan: courseLocked});
                state.lastPrediction = p ? {...p, completed, raceS: clock.elapsedS} : null;
            }
            // Time left in the interval (countdown.mjs): counts down in real time.
            state.left = advanceCountdown(state.countdown, {
                intervals: plan.intervals, index, planM, raceS: clock.elapsedS,
                power: Number.isFinite(power) ? power : null, tracking: state.tracking, riderKg: plan.weightKg,
            });
            const wMs = worldTimeOf(data, nowMs);
            if (Number.isFinite(power) && plan.cp > 0 && plan.wPrimeJ > 0 && state.wbalLastMs != null && wMs > state.wbalLastMs) {
                state.wbalJ = wbalUpdate(state.wbalJ, power, plan.cp, (wMs - state.wbalLastMs) / 1000, plan.wPrimeJ, {level: plan.fitnessLevel});
            }
            state.wbalLastMs = wMs;
            // The W' the rider closed an interval with, against the plan's figure for it.
            const closed = before != null && before !== index ? state.tracking.stats[before] : null;
            if (closed?.finished && closed.wbalEndJ == null) {
                closed.wbalEndJ = state.wbalJ;
            }
            // The finish: the measured course's finish (its time between this tick and the last, at
            // the finish metre), else Sauce's distance to go spent (when the event has a length),
            // else the plan's end at this tick's time. The interval ridden closes there.
            const toGo = distanceToGoM(data);
            // Sauce's distance to go is spent, with the rider at the event's length (FINISH_SLACK_M):
            // one stray reading of 0 mid-race (2026-11-26 audit) is not the finish.
            const edM = eventDistanceM(data);
            const finished = courseEndM != null
                ? planM >= courseEndM
                : sauceLength
                    ? eventNow && toGo != null && toGo <= 0 && edM != null && raceLengthM(data) - edM <= FINISH_SLACK_M
                    : index >= plan.intervals.length;
            const lastPoint = state.lastRacePoint;
            state.lastRacePoint = {planM, raceS: clock.elapsedS};
            if (finished) {
                state.finishS = courseEndM != null ? crossingS(lastPoint, {planM, raceS: clock.elapsedS}, courseEndM) : clock.elapsedS;
                closeInterval(state.tracking, {raceS: state.finishS, power: Number.isFinite(power) ? power : null});
                const ridden = state.tracking.stats[state.tracking.lastIndex];
                if (ridden?.finished && ridden.wbalEndJ == null) {
                    ridden.wbalEndJ = state.wbalJ;
                }
                // The total and the ahead or behind are the finish's own, not the last prediction's
                // (made up to a second before, from the tick before it).
                if (state.lastPrediction) {
                    state.lastPrediction = {...state.lastPrediction, remainingS: 0, totalS: state.finishS, deltaS: state.finishS - state.lastPrediction.planTotalS};
                }
                setStatus('finished', nowMs);
                const how = courseEndM != null ? ' (the course\'s finish)' : '';
                log(state.gunS != null
                    ? `Finished: ${(state.finishS + state.gunS).toFixed(1)} s from the gun (${state.finishS.toFixed(1)} s from the timing line)${how}`
                    : `Finished: ${state.finishS.toFixed(1)} s on the clock${how}`, nowMs);
            }
        } else {
            state.index = index;
            state.left = null;
        }
    }

    /**
     * A plan from here, on a tick: still where it was made (that event's subgroup, or that
     * route outside an event)? Then it is armed if it was idle, and the caller races it from
     * its anchor. Once the rider leaves, it is spent: statistics cleared, idle, for good.
     */
    function hereInPlace(data, nowMs, plan) {
        const here = plan.fromHere;
        const sg = data.state?.eventSubgroupId ?? data.eventSubgroupId ?? null;
        const routeId = data.state?.routeId;
        const inPlace = here.kind === 'event'
            ? sg != null && String(sg) === here.subgroupId
            : !sg && (here.routeId == null || (routeId != null && String(routeId) === here.routeId));
        if (state.hereSpent) {
            return false;
        }
        if (!inPlace) {
            state.hereSpent = true;
            clearRace(here.kind === 'event' ? 'left the event the plan from here was made in' : 'left the route the plan from here was made on', nowMs);
            setStatus('idle', nowMs);
            return false;
        }
        state.event = {...state.event, subgroupId: sg};
        if (state.status === 'idle') {
            clearRace('plan from here', nowMs);
            setStatus('armed', nowMs);
        }
        return true;
    }

    function smoothPower(data, nowMs) {
        const p = numberOrNull(data.state?.power) ?? NaN;
        if (!Number.isFinite(p)) {
            return;
        }
        const tau = (state.prefs.smoothingSec || 0) * 1000;
        const ms = worldTimeOf(data, nowMs);
        if (tau <= 0 || state.ema == null || state.emaMs == null || ms <= state.emaMs) {
            state.ema = p;
        } else {
            const alpha = 1 - Math.exp(-(ms - state.emaMs) / tau);
            state.ema += alpha * (p - state.ema);
        }
        state.emaMs = ms;
    }

    // After a finish the rider is still in the event, with the timer running on and the distance
    // to go spent: clearing the race there must not start a new one on that timer (a Reset or a
    // plan loaded after the finish gave a second finish, 30 s late, in the audit). The subgroup
    // to wait out, or null.
    function spentEvent() {
        return state.status === 'finished' && state.tick && inEvent(state.tick) ? subgroupOf(state.tick) : null;
    }

    function control(name, value) {
        if (!(name in DEFAULT_CONTROLS)) {
            return;
        }
        const v = Number(value);
        if (!Number.isFinite(v)) {
            return;
        }
        state.controls[name] = name === 'bias' ? Math.min(1.3, Math.max(0.8, v)) : Math.max(-2000, Math.min(2000, v));
    }

    function setPrefs(prefs) {
        state.prefs = {...state.prefs, ...prefs};
    }

    function event(name, payload = {}, nowMs = Date.now()) {
        switch (name) {
            case 'plan': {
                const next = payload?.plan ? (payload.plan.signature ? payload.plan : normalisePlan(payload.plan, {code: payload.code})) : null;
                if (samePlan(next, state.plan)) {
                    return;
                }
                const spent = spentEvent();
                state.plan = next;
                state.hereSpent = false;
                state.controls = {...DEFAULT_CONTROLS};
                clearRace(next ? `plan ${next.routeName ?? next.code ?? ''}` : 'plan cleared', nowMs);
                state.afterFinish = spent;
                setStatus('idle', nowMs);
                if (next && state.tick) {
                    tick(state.tick, nowMs);
                }
                break;
            }
            case 'strategy': {
                // The same plan in another strategy, any time (Dave, 2026-11-09; decision 8 was
                // before the start only). Not racing, it is a new plan. Racing, the targets
                // change in place: the clock, the W', the position, the anchors and the
                // rider's controls stay; the interval statistics start again (the strategies'
                // intervals differ), the interval in progress as a partial one.
                const next = payload?.plan ? (payload.plan.signature ? payload.plan : normalisePlan(payload.plan, {code: payload.code})) : null;
                if (samePlan(next, state.plan)) {
                    return;
                }
                if (state.status !== 'racing' || !next || !state.plan) {
                    event('plan', payload, nowMs);
                    return;
                }
                state.plan = next;
                state.tracking = createTracking();
                state.index = BEFORE;
                state.displayIndex = BEFORE;
                state.planTimeAtStart = planTimeAtMetre(next.intervals, state.clock.startPlanM ?? 0);
                state.lastPrediction = null;
                state.countdown = createCountdown();
                state.left = null;
                log(`Strategy changed while racing: ${next.strategyLabel ?? 'as shared'}`, nowMs);
                if (state.tick) {
                    tick(state.tick, nowMs);
                }
                break;
            }
            case 'reset': {
                const spent = spentEvent();
                clearRace('reset by the rider', nowMs);
                state.afterFinish = spent;
                // The rider says the race is now: a join still waiting for the pen gives way (the
                // pen, if it comes, arms the race again: PEN_HOLD_MS).
                state.joining = false;
                setStatus(state.plan && state.tick && !state.hereSpent ? 'armed' : 'idle', nowMs);
                if (state.tick && !inEvent(state.tick)) {
                    state.anchorDistanceM = rideDistanceM(state.tick);
                    state.armedWorldMs = worldTimeOf(state.tick, nowMs);
                }
                break;
            }
            case 'start':
                // Free ride: start the clock now (the manual kind starts on the next tick).
                if (state.status === 'armed' && state.tick && !inEvent(state.tick)) {
                    state.anchorDistanceM = rideDistanceM(state.tick);
                    state.armedWorldMs = worldTimeOf(state.tick, nowMs);
                    tick(state.tick, nowMs);
                }
                break;
            case 'eventInfo': {
                // {subgroupId, kind: 'tt'|'group', startMs, name}
                if (payload.subgroupId != null && String(payload.subgroupId) === String(state.event.subgroupId ?? payload.subgroupId)) {
                    state.event = {...state.event, kind: payload.kind ?? state.event.kind, startMs: payload.startMs ?? null, name: payload.name ?? null, infoFor: payload.subgroupId};
                    log(`Event: ${payload.name ?? payload.subgroupId} (${payload.kind ?? 'unknown kind'})`, nowMs);
                    noteGun(nowMs);
                }
                break;
            }
            case 'home':
                state.home = payload?.athleteId ? String(payload.athleteId) : null;
                state.spectating = null;
                break;
            default:
                break;
        }
    }

    function view() {
        const plan = state.plan;
        const data = state.tick;
        const s = data?.state ?? {};
        const bias = state.controls.bias;
        const intervals = plan?.intervals ?? [];
        // Past the last boundary but not finished, the last interval stays the target.
        const dispIdx = state.displayIndex >= intervals.length && state.status !== 'finished' && intervals.length
            ? intervals.length - 1 : state.displayIndex;
        const current = at(intervals, dispIdx);
        const trackedCurrent = at(intervals, state.index);
        const nextIndex = dispIdx === BEFORE ? (intervals.length ? 0 : null) : (dispIdx + 1 < intervals.length ? dispIdx + 1 : null);
        const next = nextIndex != null ? intervals[nextIndex] : null;
        const bnd = plan && state.planM != null ? boundary(intervals, dispIdx, state.planM) : null;
        // The course, while the rider is in the event it was matched in.
        const courseNow = state.course && data && inEvent(data) && !plan?.fromHere && courseMetre(state.course) != null ? state.course : null;
        const speedMs = (Number(s.speed) || 0) / 3.6;
        const target = current ? current.powerW * bias : (next && state.displayIndex === BEFORE ? next.powerW * bias : null);
        const live = state.ema;
        let band = null;
        if (target != null && Number.isFinite(live)) {
            const w = state.prefs.bandWidthW;
            band = live < target - w ? 'under' : live > target + w ? 'over' : 'on';
        }
        const stats = trackedCurrent ? state.tracking.stats[state.index] : null;
        // Time left in the interval: the countdown while racing in one (it counts down in
        // real time), else the metres over the speed of the moment.
        const counting = state.status === 'racing' && state.left && current && current === trackedCurrent ? state.left : null;
        const leftS = counting ? counting.leftS : bnd && speedMs > 0 ? bnd.toNextM / speedMs : null;
        const elapsedS = stats?.elapsedS ?? null;
        const p = state.lastPrediction;
        const wPrime = plan?.wPrimeJ ?? null;
        const raceS = state.finishS ?? (state.clock.running ? state.clock.elapsedS : null);
        const gunS = state.gunS;
        return {
            status: state.status,
            spectating: state.spectating,
            plan: plan ? {
                code: plan.code, routeName: plan.routeName, routeId: plan.routeId, lengthM: plan.lengthM,
                timeS: plan.timeS, timeText: plan.timeText, avgPowerW: plan.avgPowerW, cp: plan.cp, wPrimeJ: plan.wPrimeJ,
                intervals: intervals.length, source: plan.source, strategy: plan.strategy, cards: plan.cards,
                card: plan.card, strategyLabel: plan.strategyLabel, sharedTimeText: plan.sharedTimeText,
                peakPowerW: plan.peakPowerW, floorKj: plan.wbalFloorKj,
                fromHere: plan.fromHere ? {...plan.fromHere, spent: state.hereSpent} : null,
            } : null,
            controls: {...state.controls},
            rider: data ? {athleteId: idOf(data), name: nameOf(data), weightKg: Number(data.athlete?.weight) || plan?.weightKg || null} : null,
            live: {
                powerW: Number.isFinite(live) ? live : null,
                rawPowerW: numberOrNull(s.power),
                speedKmh: Number.isFinite(Number(s.speed)) ? Number(s.speed) : null,
                cadence: Number.isFinite(Number(s.cadence)) ? Number(s.cadence) : null,
                heartrate: Number.isFinite(Number(s.heartrate)) ? Number(s.heartrate) : null,
                grade: Number.isFinite(Number(s.grade)) ? Number(s.grade) * 100 : null,
                wkg: Number.isFinite(live) && Number(data?.athlete?.weight) > 0 ? live / Number(data.athlete.weight) : null,
            },
            target: target != null ? {
                powerW: target, planPowerW: current?.powerW ?? next?.powerW ?? null, band,
                index: current ? current.index : (next ? next.index : null), number: current ? current.number : (next ? next.number : null),
                grade: current?.grade ?? null, startM: current?.startM ?? null, endM: current?.endM ?? null,
                durationS: current?.durationS ?? null, durationText: current?.durationText ?? null,
                progress: bnd?.progress ?? 0, toNextM: bnd?.toNextM ?? null,
                toNextS: leftS,
                // Through the interval by time when counting down (the countdown's ring and bar), else null.
                timeProgress: counting && elapsedS != null && elapsedS + leftS > 0 ? Math.min(1, Math.max(0, elapsedS / (elapsedS + leftS))) : null,
                avgPowerW: stats?.avgPowerW ?? null, elapsedS: stats?.elapsedS ?? null,
                beforePlan: dispIdx === BEFORE,
            } : null,
            next: next ? {
                index: next.index, number: next.number, powerW: next.powerW * bias, planPowerW: next.powerW, grade: next.grade,
                startM: next.startM, endM: next.endM, durationS: next.durationS, durationText: next.durationText,
                inM: bnd?.toNextM ?? null, inS: leftS,
                changeW: current ? (next.powerW - current.powerW) * bias : null,
            } : null,
            race: {
                running: state.clock.running, signal: state.clock.signal,
                // The finished race keeps its time: the clock at the finish, not at the moment of looking.
                // This clock, the plan's time and the delta all run from the timing line.
                elapsedS: raceS,
                // A mass start's result counts from the gun: the seconds from the gun to the line, and
                // the race time and the predicted finish on that clock. Null in a TT or a free ride,
                // where the clock above is the result's.
                gunToLineS: gunS,
                officialElapsedS: gunS != null && raceS != null ? raceS + gunS : null,
                officialTotalS: gunS != null && p?.totalS != null ? p.totalS + gunS : null,
                planM: state.planM, lengthM: plan?.lengthM ?? null,
                finishM: plan ? (p?.finishM ?? finishMetre(data, plan, state.planM, courseNow)) : null,
                remainingM: plan && state.planM != null ? Math.max(0, (p?.finishM ?? finishMetre(data, plan, state.planM, courseNow)) - state.planM) : null,
                planTimeFromStartS: plan ? (p?.planTotalS ?? Math.max(0, planTimeAtMetre(plan.intervals, finishMetre(data, plan, state.planM, courseNow)) - state.planTimeAtStart)) : null,
                remainingS: p?.remainingS ?? null, totalS: p?.totalS ?? null, deltaS: p?.deltaS ?? null, pacing: p?.pacing ?? null,
                deficitS: p?.deficitS ?? null, timeRatio: p?.timeRatio ?? null,
                pacingSampleS: p?.sampleS ?? 0,
                completed: state.tracking.stats.filter(x => x?.finished).length,
                alignment: plan ? alignmentWith(alignmentOf(data, plan, courseNow), state.outOfStepM) : null,
            },
            wbal: wPrime && state.wbalJ != null ? {
                j: state.wbalJ, kj: state.wbalJ / 1000, pct: state.wbalJ / wPrime * 100, wPrimeJ: wPrime,
                floorKj: plan.wbalFloorKj, planKjAtEnd: trackedCurrent?.wbalKj ?? null,
            } : null,
            event: data ? {
                inEvent: inEvent(data), subgroupId: state.event.subgroupId, kind: state.event.kind, name: state.event.name,
                startMs: state.event.startMs,
                routeMatches: routeMatches(data, plan), lengthM: eventLengthM(data), lengthFor: eventLengthFor(data), mismatchM: mismatchM(data, plan),
                position: data.eventPosition ?? null, participants: data.eventParticipants ?? null,
                lineM: plan ? (courseNow ? courseNow.lineM : lineInPlanM(data, plan)) : null,
            } : null,
            stats: state.tracking.stats,
            log: state.log,
        };
    }

    return {tick, view, control, setPrefs, event, get state() { return state; }};
}

/**
 * Where the race ends in plan metres. A measured course on the road: its finish. With the course
 * locked: the rider's plan metre plus the distance to go on the odometer (scaled as the course
 * is). Otherwise the event's distance from the line, when Sauce reports one shorter than the
 * plan; else the plan's end.
 */
function finishMetre(data, plan, planM = null, course = null) {
    if (!plan) {
        return null;
    }
    if (plan.fromHere) {
        return plan.lengthM;     // made to end at the finish (or the route lap's end)
    }
    const measuredEndM = courseMetre(course) != null ? courseFinishM(plan, data) : null;
    if (measuredEndM != null) {
        return measuredEndM;
    }
    const eventM = raceLengthM(data);
    if (eventM == null) {
        return plan.lengthM;
    }
    const ed = eventDistanceM(data);
    if (courseMetre(course) != null && planM != null && ed != null) {
        return planM + course.k * (eventM - ed);
    }
    return Math.min(plan.lengthM, eventM + lineInPlanM(data, plan));
}

// Sauce's event length this far from a measured course's finish: another race (more laps, another
// route) than the plan's, and the course's finish is not this race's.
const COURSE_FINISH_TRUST_M = 500;

/**
 * The finish of a course whose finish was measured from races (route.finish_source: metre 0 is
 * the timing line and finish_m the finish, past the course's last point when the finish is
 * beyond the route data), in plan metres, or null. Sauce's own event length comes from the route
 * data and can be wrong: 84 m long on Crit Cross (2026-11-23), so the mod finished 7 s after the
 * line (24:15 for ZwiftPower's 24:08). A course measured for its line only (the Hilly Route) keeps
 * Sauce's finish, which was right there.
 */
function courseFinishM(plan, data) {
    if (plan?.finishSource !== 'measured' || plan.fromHere || !plan.course) {
        return null;
    }
    const endM = plan.finishM ?? plan.lengthM;
    if (!(endM > 0)) {
        return null;
    }
    const eventM = raceLengthM(data);
    return eventM != null && Math.abs(eventM - endM) > COURSE_FINISH_TRUST_M ? null : endM;
}

/** The race time at metre m between two race points ({planM, raceS}); the later one's without a straddle. */
function crossingS(before, after, m) {
    if (before && Number.isFinite(before.planM) && Number.isFinite(before.raceS) && after.planM > before.planM && before.planM <= m && m <= after.planM) {
        return before.raceS + (m - before.planM) / (after.planM - before.planM) * (after.raceS - before.raceS);
    }
    return after.raceS;
}

function idOf(data) {
    const id = data?.athleteId ?? data?.athlete?.id ?? null;
    return id == null ? null : String(id);
}

function nameOf(data) {
    return data?.athlete?.sanitizedFullname || data?.athlete?.fullname || null;
}
