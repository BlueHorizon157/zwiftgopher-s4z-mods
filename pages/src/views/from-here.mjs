// Plan from here (README "Plan from here"; the planner's TT/docs/plan-from-here.md): with no
// plan for the ride, the planner plans the rest of a race, or of a free ride's route lap,
// from where the rider is, with the W' and the CP the ride so far has left them. Pure: the
// window gives it the tick, the event info, Sauce's streams and the settings.

export const MIN_REMAINING_M = 500;      // less to go: no plan, just go (the planner says the same)
export const MAX_HISTORY_S = 6 * 3600;   // the power sent: the newest six hours
export const SHORT_GAP_S = 3;            // a gap in Sauce's samples up to this is held; longer is a pause
export const DRAFTED_S = 10;             // seconds of draft that make it a road bike (TT bikes get none)
export const NO_DRAFT_RACE_S = 180;      // this long into a draft-legal race with no draft at all: a TT bike
export const PAUSED = -1;

/**
 * What a plan from here would plan, from the rider's tick: {ok: true, kind: 'event'|'route',
 * routeId, laps, distanceM, remainingM, name, eventId, subgroupId, rules, eventKind,
 * anchor: {rideM, worldMs, subgroupId, routeId}} or {ok: false, why}. The anchor is where
 * and when the plan starts: the engine measures the plan from the ride metre and the clock
 * from the world time. eventInfo: eventinfo.mjs's for the rider's subgroup, when known.
 */
export function hereTarget(tick, eventInfo = null) {
    const s = tick?.state;
    const rideM = Number(s?.distance);
    const worldMs = Number(s?.worldTime);
    if (!s || !Number.isFinite(rideM) || !(worldMs > 0)) {
        return {ok: false, why: 'Waiting for Zwift.'};
    }
    const sg = s.eventSubgroupId ?? tick.eventSubgroupId ?? null;
    const remaining = Number(tick.remaining);
    const metric = tick.remainingMetric;
    let kind;
    let remainingM;
    let routeId;
    let info = null;
    if (sg) {
        info = eventInfo && String(eventInfo.subgroupId) === String(sg) ? eventInfo : null;
        if (metric === 'time') {
            return {ok: false, why: 'This event is ridden for a time, not to a finish: there is no end to plan to.'};
        }
        if (!(Number(s.eventDistance) > 0)) {
            return {ok: false, why: 'The race has not started: Plan it plans it from the start.'};
        }
        if (metric !== 'distance' || !(remaining > 0)) {
            return {ok: false, why: 'Sauce has not said how far the finish is yet.'};
        }
        kind = 'event';
        remainingM = remaining;
        routeId = info?.routeId ?? s.routeId ?? null;
        if (routeId == null) {
            return {ok: false, why: 'The event\'s route is not known yet.'};
        }
    } else {
        routeId = s.routeId ?? null;
        if (!routeId) {
            return {ok: false, why: 'Pick a route in Zwift: a free ride with no route has no end to plan to.'};
        }
        if (tick.remainingType === 'route' && metric === 'distance' && remaining > 0) {
            remainingM = remaining;
        } else if (Number(s.routeEnd) > 0 && Number.isFinite(Number(s.routeDistance))) {
            remainingM = Number(s.routeEnd) - Number(s.routeDistance);
        } else {
            return {ok: false, why: 'Sauce has not placed you on the route yet.'};
        }
        kind = 'route';
    }
    if (!(remainingM >= MIN_REMAINING_M)) {
        return {ok: false, why: 'Under 500 m to go: no plan needed, empty the tank.'};
    }
    return {
        ok: true,
        kind,
        routeId: String(routeId),
        laps: kind === 'event' ? (Number(info?.laps) || null) : null,
        distanceM: kind === 'event' ? (Math.round(Number(info?.distanceM)) || null) : null,
        remainingM: Math.round(remainingM),
        name: info?.name ?? null,
        eventId: info?.eventId ?? null,
        subgroupId: sg != null ? String(sg) : null,
        startMs: info?.startMs ?? null,
        rules: Array.isArray(info?.rules) ? info.rules : [],
        eventKind: info?.kind ?? null,
        anchor: {rideM, worldMs, subgroupId: sg != null ? String(sg) : null, routeId: String(routeId)},
    };
}

/**
 * The ride's power for the planner from Sauce's getAthleteStreams: one value a second, whole
 * watts, PAUSED where nothing was ridden (auto-pause, a gap over SHORT_GAP_S), the newest
 * MAX_HISTORY_S. raceFromS: the second the race began, from the distance stream (the ride
 * metre eventDistanceM before the latest), 0 outside a race. draftS: seconds with draft in
 * the race (the whole ride outside one); raceS: seconds ridden in it.
 */
export function powerHistory(streams, {eventDistanceM = null} = {}) {
    const time = Array.isArray(streams?.time) ? streams.time : [];
    const power = Array.isArray(streams?.power) ? streams.power : [];
    const n = Math.min(time.length, power.length);
    const empty = {power: [], raceFromS: 0, draftS: 0, raceS: 0};
    if (!n) {
        return empty;
    }
    // Sauce writes every stream with the power samples; read the others from the end.
    const tail = (arr, i) => (Array.isArray(arr) && arr.length >= n ? arr[arr.length - n + i] : undefined);
    const distance = streams.distance;
    const draft = streams.draft;
    const active = streams.active;

    let raceFrom = 0;
    if (Number(eventDistanceM) > 0 && Array.isArray(distance) && distance.length >= n) {
        const startM = Number(tail(distance, n - 1)) - Number(eventDistanceM);
        while (raceFrom < n - 1 && !(Number(tail(distance, raceFrom)) >= startM)) {
            raceFrom++;
        }
    }

    const out = [];
    const t0 = Number(time[0]);
    let prevK = -1;
    let raceFromS = 0;
    let draftS = 0;
    let raceS = 0;
    for (let i = 0; i < n; i++) {
        const k = Math.round(Number(time[i]) - t0);
        if (!Number.isFinite(k) || k <= prevK) {
            continue;
        }
        const p = Number(power[i]);
        const ridden = tail(active, i) !== false && Number.isFinite(p);
        const w = ridden ? Math.max(0, Math.round(p)) : PAUSED;
        const gap = k - prevK;
        for (let j = prevK + 1; j < k; j++) {
            out.push(gap <= SHORT_GAP_S ? w : PAUSED);
        }
        out.push(w);
        if (i === raceFrom) {
            raceFromS = k;
        }
        if (i >= raceFrom && ridden) {
            raceS++;
            if (Number(tail(draft, i)) > 0) {
                draftS++;
            }
        }
        prevK = k;
    }
    const drop = Math.max(0, out.length - MAX_HISTORY_S);
    return {power: drop ? out.slice(drop) : out, raceFromS: Math.max(0, raceFromS - drop), draftS, raceS};
}

/**
 * The bike for the plan (Dave, 2026-11-09): a road bike unless something says TT. The
 * setting wins; else a no-draft event is a TT; draft in the ride is a road bike (TT bikes
 * get none in Zwift); a draft-legal race ridden for a while with no draft at all is a TT;
 * anything else, a road bike. {bike: 'road'|'tt', reason}.
 */
export function chooseBike({setting = 'auto', target = null, draftS = 0, raceS = 0} = {}) {
    if (setting === 'road' || setting === 'tt') {
        return {bike: setting, reason: 'setting'};
    }
    if (target?.kind === 'event' && (target.eventKind === 'tt' || (target.rules ?? []).includes('NO_DRAFTING'))) {
        return {bike: 'tt', reason: 'no-draft event'};
    }
    if (draftS >= DRAFTED_S) {
        return {bike: 'road', reason: 'drafted'};
    }
    if (target?.kind === 'event' && raceS >= NO_DRAFT_RACE_S) {
        return {bike: 'tt', reason: 'no draft in the race'};
    }
    return {bike: 'road', reason: 'default'};
}

/**
 * Whether the HUD offers Plan from here: linked, the rider's own ride, a target, and no plan
 * running for this ride: nothing loaded, a plan waiting for another ride, a plan from here
 * that is over, or a plan for another distance being raced (mismatch).
 */
export function hereOffered({linked, spectating = false, status, plan = null, mismatchM = null, spent = false, target}) {
    if (!linked || spectating || !target?.ok) {
        return false;
    }
    if (!plan || status === 'idle' || spent) {
        return true;
    }
    if (plan.fromHere && status === 'finished') {
        return true;
    }
    return status === 'racing' && Number.isFinite(mismatchM);
}

/** The banner while riding a plan from here: "from here · road bike · tired legs". */
export function hereWords(fromHere) {
    if (!fromHere) {
        return '';
    }
    const parts = ['from here'];
    if (fromHere.bike === 'tt' || fromHere.bike === 'road') {
        parts.push(fromHere.bike === 'tt' ? 'TT bike' : 'road bike');
    }
    if (fromHere.overBudget) {
        parts.push('past what you can hold');
    } else if (fromHere.cpFactor < 0.9) {
        parts.push('very tired legs');
    } else if (fromHere.cpFactor < 0.98) {
        parts.push('tired legs');
    }
    return parts.join(' · ');
}

/** Why the bike, in words, for the note after planning. */
export function bikeWords({bike, reason}) {
    const what = bike === 'tt' ? 'a TT bike' : 'a road bike';
    switch (reason) {
        case 'setting': return `${what} (your setting)`;
        case 'no-draft event': return `${what} (a no-draft event)`;
        case 'drafted': return `${what} (you have had draft)`;
        case 'no draft in the race': return `${what} (no draft all race)`;
        default: return what;
    }
}
