// How the finish is shaping up (the field window and the rivals strip): each rider's gap on the
// clock when you finish, at the pace of the last four minutes (field-model.mjs), the places that
// gives, and one verdict for a glance: clear, defend, chase or contested.
//
// No rider is modelled on the route: your own finish comes from your plan (the engine's
// prediction knows the climbs), and each rider's is yours less their clock gap carried to the
// line at their pace against you. A rider who has finished is at their real finish time: the
// line they crossed on their own clock (field-model.mjs finishRaceOf).
//
// The places are the riders' order at the finish (1 + the riders finishing ahead of you), so
// nothing is clamped and nothing comes from Zwift. They are shown only once the outlook is
// settled: after OUTLOOK.gateElapsedS of racing, or with OUTLOOK.gateToGoS left (the first
// minutes of a race gave wrong calls on 2026-11-10: a rider who ends up behind was called
// beating you before the gate).
//
// States, on the clock (the rider's result against yours):
//   beat      ahead now, and at this pace you finish ahead of them
//   beaten    behind now, and at this pace they finish ahead of you
//   reach     ahead, close at the finish: a little more from you, or a fade from them
//   pressure  behind, close at the finish
//   clear     not close at the finish either way: nothing to think about
// Close is a second per minute to go, 5 s to 30 s. A state holds on past its line for a margin
// (prev, the last result) so a rider on the edge does not flicker.

import {placeOf} from './field-model.mjs';

export const OUTLOOK = {
    closePerMin: 1,       // close at the finish: 1 s per minute to go,
    closeMinS: 5,         //   at least 5 s,
    closeMaxS: 30,        //   at most 30 s
    closeLeave: 1.25,     // a close rider stays close to 25 % beyond it
    crossS: 1,            // beat / beaten from 1 s past level, held back to 0.5 s short of it
    holdS: 0.5,
    settledS: 240,        // a pace from fewer seconds than this is early (shown faint)
    gateElapsedS: 1200,   // the outlook is settled after 20 minutes of racing ...
    gateToGoS: 300,       // ... or with 5 minutes or less to go
};

const AHEAD = new Set(['beat', 'reach']);
const BEHIND = new Set(['beaten', 'pressure']);

/**
 * list: field rows (field-model.rows()). remainingS: your time to go (0 once finished). elapsedS:
 * your race time so far (for the early gate). homeFinishS: your predicted race time at the
 * finish (optional; from the home row when you have finished). prev: last call's result.
 * Returns null without a time to go, else {closeS, remainingS, settled, riders: Map(id → {state,
 * gapS, finishGapS, needSPerMin, paceSPerMin, finishS, finished, early, place}), home: {place,
 * of, predictedPlace, finishPlace, finishers, finishS}, verdict}. Places and the verdict's places
 * are null until settled.
 */
export function finishOutlook(list, {remainingS = null, elapsedS = null, homeFinishS = null, prev = null} = {}) {
    if (!Number.isFinite(remainingS)) {
        return null;
    }
    const o = OUTLOOK;
    const remMin = Math.max(0, remainingS) / 60;
    const closeS = Math.min(o.closeMaxS, Math.max(o.closeMinS, remMin * o.closePerMin));
    const done = remainingS <= 0;
    const settled = done || remainingS <= o.gateToGoS || (Number.isFinite(elapsedS) && elapsedS >= o.gateElapsedS);
    const home = list.find(r => r.isHome) ?? null;
    const finishing = Number.isFinite(homeFinishS) ? homeFinishS : (home?.finished && Number.isFinite(home.finishRaceS) ? home.finishRaceS : null);
    const riders = new Map();
    for (const r of list) {
        if (r.isHome || !r.comparable || !Number.isFinite(r.gapS)) {
            continue;
        }
        const gapS = r.gapS;
        const known = r.finished && r.finishRaceS != null && finishing != null;
        let finishGapS;
        let pace = null;
        if (known) {
            finishGapS = finishing - r.finishRaceS;
        } else if (r.finished) {
            finishGapS = gapS;
        } else {
            pace = Number.isFinite(r.paceSPerMin) ? r.paceSPerMin : null;
            finishGapS = gapS - (pace ?? 0) * remMin;
        }
        const was = prev?.riders?.get(r.id)?.state;
        const ahead = gapS > 0;
        const fg = ahead ? finishGapS : -finishGapS;     // > 0: still on their side at the finish
        let state;
        if (fg < -o.crossS || (was === (ahead ? 'beat' : 'beaten') && fg < o.holdS)) {
            state = ahead ? 'beat' : 'beaten';
        } else if (Math.abs(finishGapS) <= closeS * ((ahead ? AHEAD : BEHIND).has(was) ? o.closeLeave : 1)) {
            state = ahead ? 'reach' : 'pressure';
        } else {
            state = 'clear';
        }
        riders.set(r.id, {
            id: r.id,
            name: r.name,
            state,
            gapS,
            finishGapS,
            paceSPerMin: pace,
            needSPerMin: remMin > 0 ? Math.abs(finishGapS) / remMin : null,
            finished: Boolean(r.finished),
            finishS: r.finished && r.finishRaceS != null ? r.finishRaceS : (finishing != null ? finishing - finishGapS : null),
            early: !settled || (!known && !r.finished && (pace == null || !((r.paceSpanS ?? 0) >= o.settledS))),
            place: null,
        });
    }
    // Places at the finish: 1 + the riders finishing ahead of you; each rider's place is 1 + the
    // riders finishing ahead of them, and one more when you finish ahead of them.
    const all = [...riders.values()];
    const predictedPlace = settled ? 1 + all.filter(x => x.finishGapS > 0).length : null;
    if (predictedPlace != null) {
        for (const x of all) {
            x.place = 1 + all.filter(y => y.finishGapS > x.finishGapS).length + (x.finishGapS < 0 ? 1 : 0);
        }
    }
    const now = placeOf(list);
    const homeOut = {
        place: now.place,
        of: now.of,
        predictedPlace,
        finishPlace: home?.finishPlace ?? null,
        finishers: home?.finishers ?? null,
        finishS: finishing,
    };
    return {closeS, remainingS, settled, riders, home: homeOut, verdict: verdictOf(all, homeOut, remainingS, settled)};
}

/**
 * The verdict: {kind, rider (the one it is about), others (how many more), lo, hi (the places
 * in contention), spreadS, upS, backS (the nearest gaps at the finish either way)}. kind:
 *   early      not settled yet (see OUTLOOK.gateElapsedS), or no rider has a pace yet
 *   done       you have finished
 *   contested  riders close or crossing on both sides
 *   defend     someone beats you, or finishes close behind
 *   chase      you beat someone, or one finishes close ahead
 *   clear      nobody close either way: ride your plan
 */
function verdictOf(all, home, remainingS, settled) {
    const base = {rider: null, others: 0, lo: null, hi: null, spreadS: null, upS: null, backS: null};
    const ahead = all.filter(x => x.finishGapS > 0).sort((a, b) => a.finishGapS - b.finishGapS);
    const behind = all.filter(x => x.finishGapS <= 0).sort((a, b) => b.finishGapS - a.finishGapS);
    base.upS = ahead[0]?.finishGapS ?? null;
    base.backS = behind[0] ? -behind[0].finishGapS : null;
    if (remainingS <= 0) {
        return {...base, kind: 'done'};
    }
    if (!settled || !all.length || all.every(x => x.paceSPerMin == null && !x.finished)) {
        return {...base, kind: 'early'};
    }
    const by = state => all.filter(x => x.state === state).sort((a, b) => Math.abs(a.finishGapS) - Math.abs(b.finishGapS));
    const threats = [...by('beaten'), ...by('pressure')];
    const targets = [...by('beat'), ...by('reach')];
    if (threats.length && targets.length) {
        const places = [...threats, ...targets].map(x => x.place).filter(Number.isFinite);
        if (home.predictedPlace != null) {
            places.push(home.predictedPlace);
        }
        return {
            ...base,
            kind: 'contested',
            rider: threats[0],
            others: threats.length + targets.length - 1,
            lo: places.length ? Math.min(...places) : null,
            hi: places.length ? Math.max(...places) : null,
            spreadS: Math.max(...[...threats, ...targets].map(x => Math.abs(x.finishGapS))),
        };
    }
    if (threats.length) {
        return {...base, kind: 'defend', rider: threats[0], others: threats.length - 1};
    }
    if (targets.length) {
        return {...base, kind: 'chase', rider: targets[0], others: targets.length - 1};
    }
    return {...base, kind: 'clear'};
}
