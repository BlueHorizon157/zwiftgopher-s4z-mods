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
// ignored. Only an explicit event or a new event subgroup clears statistics.
//
// A plan from here (plan.fromHere: views/from-here.mjs) belongs to the moment it was asked
// for: it races at once from its anchor while the rider is still in that event, or on that
// route outside one, and once they leave it is spent (idle) and never arms anywhere else.

import {normalisePlan} from './plan.mjs';
import {locate, at, boundary, BEFORE} from './cursor.mjs';
import {createClock, advanceClock, worldTimeOf} from './clock.mjs';
import {inEvent, routeMatches, planMetre, rideDistanceM, mismatchM, eventLengthM, eventDistanceM, distanceToGoM, lineInPlanM, alignmentOf} from './align.mjs';
import {createTracking, advance, closeInterval, predict, planTimeAtMetre} from './tracking.mjs';
import {createCourseTracker, advanceCourse, courseMetre} from './course.mjs';
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
        log(`Statistics cleared: ${why}`, nowMs);
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
                state.event = {subgroupId, kind: subgroupId ? state.event.kind && state.event.infoFor === subgroupId ? state.event.kind : null : null, startMs: null, name: null, infoFor: subgroupId ? state.event.infoFor : null};
                if (state.status === 'racing' || state.status === 'finished') {
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
        }

        // The course (course.mjs): in an event, the rider's position is matched on the plan's own
        // course; until it locks, the old rule places the rider.
        // Once finished the course is not fed: the metre stays where the finish put it.
        const fed = !plan.fromHere && eventNow && state.course != null && state.status !== 'finished';
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
        }
        // The course's metre: locked on the road, or carried on the odometer after a loss (course.mjs).
        const courseLocked = !plan.fromHere && eventNow && state.course?.locked === true;
        const courseTracked = !plan.fromHere && eventNow && courseMetre(state.course) != null;
        const courseJustLocked = fed && state.course.justLocked;
        const lineM = courseTracked && state.course.lineM != null ? state.course.lineM : lineInPlanM(data, plan);
        const planM = planMetre(data, {offsetM: state.controls.offsetM, anchorDistanceM: state.anchorDistanceM, plan, courseM: courseTracked ? courseMetre(state.course) : null});
        state.planM = planM;
        smoothPower(data, nowMs);
        if (state.status === 'idle') {
            return;
        }

        // The clock.
        const kind = plan.fromHere ? 'here' : eventNow ? (state.event.kind ?? 'tt') : 'manual';
        const clock = advanceClock(state.clock, {
            kind,
            rule: state.prefs.startRule,
            prev: state.prevTick,
            tick: data,
            plan,
            planM,
            eventStartMs: state.event.startMs,
            armedWorldMs: plan.fromHere ? plan.fromHere.worldMs : state.armedWorldMs,
            lineM,
        });
        state.clock = clock;
        if (clock.justStarted) {
            state.planTimeAtStart = planTimeAtMetre(plan.intervals, clock.startPlanM ?? 0);
            // A plan from here starts with the W' the ride so far left (the planner's replay).
            state.wbalJ = plan.fromHere?.startWbalJ ?? plan.wPrimeJ;
            state.wbalLastMs = worldTimeOf(data, nowMs);
            setStatus('racing', nowMs);
            log(`Clock started (${clock.signal}) at plan metre ${Math.round(clock.startPlanM ?? 0)}`, nowMs);
        }
        // The clock started at the line before the course found it (Zwift's time, or the event
        // distance from the line): the plan time at the start is the line's, now the line is known.
        if (courseJustLocked && state.clock.running && (state.clock.signal === 'time' || state.clock.signal === 'distance')) {
            state.clock = {...state.clock, startPlanM: lineM};
            state.planTimeAtStart = planTimeAtMetre(plan.intervals, lineM);
        }

        // The cursor, the statistics, the prediction, the W'.
        const power = Number(data.state?.power);
        const rawIndex = planM == null ? state.index : locate(plan.intervals, planM, state.index);
        // With the event's length known, the race ends at the finish, not the plan's end: past
        // the plan's last boundary the last interval stays the target and is ridden on.
        const sauceLength = eventLengthM(data) != null;
        const index = sauceLength && rawIndex >= plan.intervals.length ? plan.intervals.length - 1 : rawIndex;
        const speedMs = (Number(data.state?.speed) || 0) / 3.6;
        // The shown interval is the one the rider is in: the target switches at the boundary,
        // when the countdown reaches zero (Dave, 2026-10-27). The plan's boundaries are the
        // optimum (REVAMP_PLAN 6.3), so nothing here anticipates them.
        state.displayIndex = index;
        if (state.status === 'racing' && clock.running && planM != null) {
            const before = state.tracking.lastIndex;
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
            // The finish: Sauce's distance to go is spent (when the event has a length), else the
            // plan's end. The finish time is the clock's at that tick; the interval ridden closes there.
            const toGo = distanceToGoM(data);
            const finished = sauceLength
                ? eventNow && toGo != null && toGo <= 0
                : index >= plan.intervals.length;
            if (finished) {
                state.finishS = clock.elapsedS;
                closeInterval(state.tracking, {raceS: clock.elapsedS, power: Number.isFinite(power) ? power : null});
                const ridden = state.tracking.stats[state.tracking.lastIndex];
                if (ridden?.finished && ridden.wbalEndJ == null) {
                    ridden.wbalEndJ = state.wbalJ;
                }
                setStatus('finished', nowMs);
                log(`Finished: ${clock.elapsedS.toFixed(1)} s on the clock`, nowMs);
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
        const p = Number(data.state?.power);
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
                if (next?.signature === state.plan?.signature) {
                    return;
                }
                state.plan = next;
                state.hereSpent = false;
                state.controls = {...DEFAULT_CONTROLS};
                clearRace(next ? `plan ${next.routeName ?? next.code ?? ''}` : 'plan cleared', nowMs);
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
                if (next?.signature === state.plan?.signature) {
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
            case 'reset':
                clearRace('reset by the rider', nowMs);
                setStatus(state.plan && state.tick && !state.hereSpent ? 'armed' : 'idle', nowMs);
                if (state.tick && !inEvent(state.tick)) {
                    state.anchorDistanceM = rideDistanceM(state.tick);
                    state.armedWorldMs = worldTimeOf(state.tick, nowMs);
                }
                break;
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
                rawPowerW: Number.isFinite(Number(s.power)) ? Number(s.power) : null,
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
                elapsedS: state.finishS ?? (state.clock.running ? state.clock.elapsedS : null),
                planM: state.planM, lengthM: plan?.lengthM ?? null,
                finishM: plan ? (p?.finishM ?? finishMetre(data, plan, state.planM, courseNow)) : null,
                remainingM: plan && state.planM != null ? Math.max(0, (p?.finishM ?? finishMetre(data, plan, state.planM, courseNow)) - state.planM) : null,
                planTimeFromStartS: plan ? (p?.planTotalS ?? Math.max(0, planTimeAtMetre(plan.intervals, finishMetre(data, plan, state.planM, courseNow)) - state.planTimeAtStart)) : null,
                remainingS: p?.remainingS ?? null, totalS: p?.totalS ?? null, deltaS: p?.deltaS ?? null, pacing: p?.pacing ?? null,
                deficitS: p?.deficitS ?? null, timeRatio: p?.timeRatio ?? null,
                pacingSampleS: p?.sampleS ?? 0,
                completed: state.tracking.stats.filter(x => x?.finished).length,
                alignment: plan ? alignmentOf(data, plan, courseNow) : null,
            },
            wbal: wPrime && state.wbalJ != null ? {
                j: state.wbalJ, kj: state.wbalJ / 1000, pct: state.wbalJ / wPrime * 100, wPrimeJ: wPrime,
                floorKj: plan.wbalFloorKj, planKjAtEnd: trackedCurrent?.wbalKj ?? null,
            } : null,
            event: data ? {
                inEvent: inEvent(data), subgroupId: state.event.subgroupId, kind: state.event.kind, name: state.event.name,
                startMs: state.event.startMs,
                routeMatches: routeMatches(data, plan), lengthM: eventLengthM(data), mismatchM: mismatchM(data, plan),
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
 * Where the race ends in plan metres. With the course locked: the rider's plan metre plus the
 * distance to go on the odometer (scaled as the course is). Otherwise the event's distance from
 * the line, when Sauce reports one shorter than the plan; else the plan's end.
 */
function finishMetre(data, plan, planM = null, course = null) {
    if (!plan) {
        return null;
    }
    if (plan.fromHere) {
        return plan.lengthM;     // made to end at the finish (or the route lap's end)
    }
    const eventM = eventLengthM(data);
    if (eventM == null) {
        return plan.lengthM;
    }
    const ed = eventDistanceM(data);
    if (courseMetre(course) != null && planM != null && ed != null) {
        return planM + course.k * (eventM - ed);
    }
    return Math.min(plan.lengthM, eventM + lineInPlanM(data, plan));
}

function idOf(data) {
    const id = data?.athleteId ?? data?.athlete?.id ?? null;
    return id == null ? null : String(id);
}

function nameOf(data) {
    return data?.athlete?.sanitizedFullname || data?.athlete?.fullname || null;
}
