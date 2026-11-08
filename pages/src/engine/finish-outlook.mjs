// How the finish is shaping up (the field window and the rivals strip): each rider's gap on the
// clock when you finish, at the pace of the last four minutes (field-model.mjs), what that does
// to the places, and one verdict for a glance: clear, defend, chase or contested.
//
// No rider is modelled on the route: your own finish comes from your plan (the engine's
// prediction knows the climbs), and each rider's is yours less their clock gap carried to the
// line at their pace against you. Gaps are measured where both of you have been, so a rider
// who has finished is already at their real gap.
//
// States, on the clock (your result):
//   beat      ahead now, and at this pace you finish ahead of them
//   beaten    behind now, and at this pace they finish ahead of you
//   reach     ahead, close at the finish: a little more from you, or a fade from them
//   pressure  behind, close at the finish
//   clear     not close at the finish either way: nothing to think about
// Close is a second per minute to go, 5 s to 30 s. A state holds on past its line for a margin
// (prev, the last result) so a rider on the edge does not flicker.

export const OUTLOOK = {
    closePerMin: 1,       // close at the finish: 1 s per minute to go,
    closeMinS: 5,         //   at least 5 s,
    closeMaxS: 30,        //   at most 30 s
    closeLeave: 1.25,     // a close rider stays close to 25 % beyond it
    crossS: 1,            // beat / beaten from 1 s past level, held back to 0.5 s short of it
    holdS: 0.5,
    settledS: 240,        // a pace from fewer seconds than this is early (shown faint)
};

const AHEAD = new Set(['beat', 'reach']);
const BEHIND = new Set(['beaten', 'pressure']);

/**
 * list: field rows (rows(), any gap mode) with the home row or without. remainingS: your time
 * to go (0 once finished). homeFinishS: your predicted time from the start, for the riders'
 * predicted times (optional). homePosition: your place now (optional). Returns null without a
 * time to go, else {closeS, riders: Map(id → {state, gapS, finishGapS, needSPerMin, paceSPerMin,
 * finishS, place, early}), home: {place, predictedPlace, finishS}, verdict}.
 */
export function finishOutlook(list, {remainingS = null, homeFinishS = null, homePosition = null, prev = null} = {}) {
    if (!Number.isFinite(remainingS)) {
        return null;
    }
    const o = OUTLOOK;
    const remMin = Math.max(0, remainingS) / 60;
    const closeS = Math.min(o.closeMaxS, Math.max(o.closeMinS, remMin * o.closePerMin));
    const riders = new Map();
    for (const r of list) {
        if (r.isHome || r.stale) {
            continue;
        }
        const gapS = Number.isFinite(r.clockS) ? r.clockS : r.roadS;
        if (!Number.isFinite(gapS)) {
            continue;
        }
        const pace = Number.isFinite(r.paceSPerMin) ? r.paceSPerMin : null;
        const finishGapS = gapS - (pace ?? 0) * remMin;
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
            finishS: Number.isFinite(homeFinishS) ? homeFinishS - finishGapS : null,
            early: pace == null || !((r.paceSpanS ?? 0) >= o.settledS),
            place: null,
        });
    }
    // Places: your place now, less those you beat, plus those who beat you; the others around you
    // in order of their gap at the finish.
    const all = [...riders.values()];
    const beat = all.filter(x => x.state === 'beat').length;
    const beaten = all.filter(x => x.state === 'beaten').length;
    const predictedPlace = Number.isFinite(homePosition) && homePosition > 0 ? homePosition - beat + beaten : null;
    if (predictedPlace != null) {
        const order = [...all.map(x => ({id: x.id, g: x.finishGapS})), {id: null, g: 0}].sort((a, b) => b.g - a.g);
        const homeRank = order.findIndex(x => x.id == null);
        order.forEach((x, i) => {
            if (x.id != null) {
                riders.get(x.id).place = Math.max(1, predictedPlace + i - homeRank);
            }
        });
    }
    const home = {place: Number.isFinite(homePosition) && homePosition > 0 ? homePosition : null, predictedPlace, finishS: Number.isFinite(homeFinishS) ? homeFinishS : null};
    return {closeS, remainingS, riders, home, verdict: verdictOf(all, home, remainingS)};
}

/**
 * The verdict: {kind, rider (the one it is about), others (how many more), lo, hi (the places
 * in contention), spreadS, upS, backS (the nearest gaps at the finish either way)}. kind:
 *   early      no rider has a pace yet
 *   done       you have finished
 *   contested  riders close or crossing on both sides
 *   defend     someone beats you, or finishes close behind
 *   chase      you beat someone, or one finishes close ahead
 *   clear      nobody close either way: ride your plan
 */
function verdictOf(all, home, remainingS) {
    const base = {rider: null, others: 0, lo: null, hi: null, spreadS: null, upS: null, backS: null};
    const ahead = all.filter(x => x.finishGapS > 0).sort((a, b) => a.finishGapS - b.finishGapS);
    const behind = all.filter(x => x.finishGapS <= 0).sort((a, b) => b.finishGapS - a.finishGapS);
    base.upS = ahead[0]?.finishGapS ?? null;
    base.backS = behind[0] ? -behind[0].finishGapS : null;
    if (remainingS <= 0) {
        return {...base, kind: 'done'};
    }
    if (!all.length || all.every(x => x.paceSPerMin == null)) {
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
