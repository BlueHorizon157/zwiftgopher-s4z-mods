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

import {normalisePlan} from './plan.mjs';
import {locate, at, boundary, BEFORE} from './cursor.mjs';
import {createClock, advanceClock, worldTimeOf, lineMetre} from './clock.mjs';
import {inEvent, routeMatches, planMetre, rideDistanceM, mismatchM, eventLengthM, lineInPlanM} from './align.mjs';
import {createTracking, advance, predict, planTimeAtMetre} from './tracking.mjs';
import {update as wbalUpdate} from './wbal.mjs';

export const DEFAULT_PREFS = {
    smoothingSec: 3,
    bandWidthW: 5,
    lookAheadSec: 5,
    startRule: 'auto',      // clock.mjs START_RULES
};

export const DEFAULT_CONTROLS = {
    offsetM: 0,
    bias: 1,
};

export function createEngine({plan = null, prefs = {}, controls = {}} = {}) {
    const state = {
        plan: plan && plan.intervals && plan.signature ? plan : normalisePlan(plan),
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
        state.index = BEFORE;
        state.displayIndex = BEFORE;
        state.planTimeAtStart = 0;
        state.wbalJ = state.plan?.wPrimeJ ?? null;
        state.wbalLastMs = null;
        state.lastPrediction = null;
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
        state.prevTick = state.tick;
        state.tick = data;
        state.tickMs = nowMs;

        const plan = state.plan;
        if (!plan) {
            setStatus('idle', nowMs);
            smoothPower(data, nowMs);
            return;
        }

        // Event changes clear the race.
        const subgroupId = data.state?.eventSubgroupId ?? data.eventSubgroupId ?? null;
        if (subgroupId !== state.event.subgroupId) {
            if (state.status !== 'idle') {
                clearRace(subgroupId ? `event ${subgroupId}` : 'left the event', nowMs);
            }
            state.event = {subgroupId, kind: subgroupId ? state.event.kind && state.event.infoFor === subgroupId ? state.event.kind : null : null, startMs: null, name: null, infoFor: subgroupId ? state.event.infoFor : null};
            if (state.status === 'racing' || state.status === 'finished') {
                setStatus('armed', nowMs);
            }
        }

        const eventNow = inEvent(data);
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

        const planM = planMetre(data, {offsetM: state.controls.offsetM, anchorDistanceM: state.anchorDistanceM, plan});
        state.planM = planM;
        smoothPower(data, nowMs);
        if (state.status === 'idle') {
            return;
        }

        // The clock.
        const kind = eventNow ? (state.event.kind ?? 'tt') : 'manual';
        const clock = advanceClock(state.clock, {
            kind,
            rule: state.prefs.startRule,
            prev: state.prevTick,
            tick: data,
            plan,
            planM,
            eventStartMs: state.event.startMs,
            armedWorldMs: state.armedWorldMs,
        });
        state.clock = clock;
        if (clock.justStarted) {
            state.planTimeAtStart = planTimeAtMetre(plan.intervals, clock.startPlanM ?? 0);
            state.wbalJ = plan.wPrimeJ;
            state.wbalLastMs = worldTimeOf(data, nowMs);
            setStatus('racing', nowMs);
            log(`Clock started (${clock.signal}) at plan metre ${Math.round(clock.startPlanM ?? 0)}`, nowMs);
        }

        // The cursor, the statistics, the prediction, the W'.
        const power = Number(data.state?.power);
        const index = planM == null ? state.index : locate(plan.intervals, planM, state.index);
        const speedMs = (Number(data.state?.speed) || 0) / 3.6;
        const lookM = planM != null ? planM + speedMs * (state.prefs.lookAheadSec || 0) : null;
        state.displayIndex = lookM == null ? index : locate(plan.intervals, lookM, state.displayIndex);
        if (state.status === 'racing' && clock.running && planM != null) {
            const before = state.tracking.lastIndex;
            advance(state.tracking, {
                index,
                raceS: clock.elapsedS,
                power: Number.isFinite(power) ? power : null,
                planM,
                intervals: plan.intervals,
                atStart: clock.justStarted,
                startLineM: lineMetre(plan, data),
            });
            state.index = index;
            const prevPrediction = state.lastPrediction;
            const completed = state.tracking.stats.filter(s => s?.finished).length;
            // Re-predict when an interval completes, on the first tick, and once a second otherwise.
            if (!prevPrediction || prevPrediction.completed !== completed || clock.elapsedS - prevPrediction.raceS >= 1) {
                const p = predict({tracking: state.tracking, plan, index, planM, raceS: clock.elapsedS, planTimeAtStart: state.planTimeAtStart, finishM: finishMetre(data, plan)});
                state.lastPrediction = p ? {...p, completed, raceS: clock.elapsedS} : null;
            }
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
            if (index >= plan.intervals.length || (eventNow && data.remainingMetric === 'distance' && Number(data.remaining) <= 0)) {
                setStatus('finished', nowMs);
                log(`Finished: ${clock.elapsedS.toFixed(1)} s on the clock`, nowMs);
            }
        } else {
            state.index = index;
        }
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
                state.controls = {...DEFAULT_CONTROLS};
                clearRace(next ? `plan ${next.routeName ?? next.code ?? ''}` : 'plan cleared', nowMs);
                setStatus('idle', nowMs);
                if (next && state.tick) {
                    tick(state.tick, nowMs);
                }
                break;
            }
            case 'reset':
                clearRace('reset by the rider', nowMs);
                setStatus(state.plan && state.tick ? 'armed' : 'idle', nowMs);
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
        const speedMs = (Number(s.speed) || 0) / 3.6;
        const target = current ? current.powerW * bias : (next && state.displayIndex === BEFORE ? next.powerW * bias : null);
        const live = state.ema;
        let band = null;
        if (target != null && Number.isFinite(live)) {
            const w = state.prefs.bandWidthW;
            band = live < target - w ? 'under' : live > target + w ? 'over' : 'on';
        }
        const stats = trackedCurrent ? state.tracking.stats[state.index] : null;
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
                toNextS: bnd && speedMs > 0 ? bnd.toNextM / speedMs : null,
                avgPowerW: stats?.avgPowerW ?? null, elapsedS: stats?.elapsedS ?? null,
                beforePlan: dispIdx === BEFORE,
            } : null,
            next: next ? {
                index: next.index, number: next.number, powerW: next.powerW * bias, planPowerW: next.powerW, grade: next.grade,
                startM: next.startM, endM: next.endM, durationS: next.durationS, durationText: next.durationText,
                inM: bnd?.toNextM ?? null, inS: bnd && speedMs > 0 ? bnd.toNextM / speedMs : null,
                changeW: current ? (next.powerW - current.powerW) * bias : null,
            } : null,
            race: {
                running: state.clock.running, signal: state.clock.signal, elapsedS: state.clock.running ? state.clock.elapsedS : null,
                planM: state.planM, lengthM: plan?.lengthM ?? null,
                finishM: plan ? (p?.finishM ?? finishMetre(data, plan)) : null,
                remainingM: plan && state.planM != null ? Math.max(0, (p?.finishM ?? finishMetre(data, plan)) - state.planM) : null,
                planTimeFromStartS: plan ? (p?.planTotalS ?? Math.max(0, planTimeAtMetre(plan.intervals, finishMetre(data, plan)) - state.planTimeAtStart)) : null,
                remainingS: p?.remainingS ?? null, totalS: p?.totalS ?? null, deltaS: p?.deltaS ?? null, pacing: p?.pacing ?? null,
                deficitS: p?.deficitS ?? null, timeRatio: p?.timeRatio ?? null,
                pacingSampleS: p?.sampleS ?? 0,
                completed: state.tracking.stats.filter(x => x?.finished).length,
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
                lineM: plan ? lineMetre(plan, data) : null,
            } : null,
            stats: state.tracking.stats,
            log: state.log,
        };
    }

    return {tick, view, control, setPrefs, event, get state() { return state; }};
}

/** Where the race ends in plan metres: the event's distance when Sauce reports one shorter than the plan. */
function finishMetre(data, plan) {
    if (!plan) {
        return null;
    }
    const eventM = eventLengthM(data);
    return eventM == null ? plan.lengthM : Math.min(plan.lengthM, eventM + lineInPlanM(data, plan));
}

function idOf(data) {
    const id = data?.athleteId ?? data?.athlete?.id ?? null;
    return id == null ? null : String(id);
}

function nameOf(data) {
    return data?.athlete?.sanitizedFullname || data?.athlete?.fullname || null;
}
