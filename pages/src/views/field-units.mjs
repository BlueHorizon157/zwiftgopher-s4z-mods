// Pure helpers for the field window and the rivals strip (no Sauce, no DOM), so they can be
// tested in node. views/field-feed.mjs re-exports them.
import {remainingOf} from './race-time.mjs';

/**
 * What the field model needs from the window's view (and its plan) with each nearby list. Every
 * rider's eventDistance sits at zero until the timing line, so in event metres the line is 0,
 * whatever the route. The event's length is the line you finish at: a
 * rider who passes it is finished (field-model.mjs). lengthFor is the category it was read for
 * (null when the tick has none, as on a warm-up route). The plan's finish takes the place of
 * Sauce's length where it is better (finishLineOf). spectating: your race is paused for another
 * watched rider, so you stay home in the field.
 */
export function contextOf(v, plan = null) {
    const finishM = finishLineOf(v, plan);
    const sg = v?.event?.subgroupId;
    return {
        lineM: 0, kind: v?.event?.kind ?? null, gunMs: v?.event?.startMs ?? null,
        lengthM: finishM ?? v?.event?.lengthM ?? null,
        lengthFor: finishM != null ? (sg != null ? String(sg) : null) : (v?.event?.lengthFor ?? null),
        spectating: Boolean(v?.spectating),
    };
}

/**
 * The finish line in event metres from the plan, or null when Sauce's length stands. Sauce's own
 * route length can be wrong (84 m long on Crit Cross), and the HUD ends the race at a measured
 * finish when the plan has one (route.finish_source): the others finish where you do, or their
 * times and the gaps to the finishers are late by the stretch. And when Sauce gives no length at
 * all (a route newer than its build) the plan's end is the only finish there is. The engine's
 * own finish (race.finishM, in plan metres) comes to event metres as the sectors do: less the
 * rider's offset and the timing line, over the plan metres per game metre. Only for the route the
 * plan is for.
 */
export function finishLineOf(v, plan) {
    const finishM = Number(v?.race?.finishM);
    const lineM = Number(v?.event?.lineM);
    if (!plan || plan.fromHere || v?.event?.routeMatches !== true || !Number.isFinite(finishM) || !Number.isFinite(lineM)) {
        return null;
    }
    const measured = plan.finishSource === 'measured' && Math.abs(finishM - (plan.finishM ?? plan.lengthM)) < 1;
    if (v.event.lengthM != null && !measured) {
        return null;
    }
    const k = plan.routeMPerGameM > 0 ? plan.routeMPerGameM : 1;
    const m = (finishM - (Number(v.controls?.offsetM) || 0) - lineM) / k;
    return m > 0 ? m : null;
}

/**
 * The finish outlook's inputs from the window's view and the rows: your time to go, your race
 * time so far, and your race time at the finish (now plus the time to go; once you are through,
 * your own finish). Null where not known, and all null while spectating: the view is your race as
 * it stood when you started watching someone else.
 */
export function outlookInputsOf(v, list) {
    if (v?.spectating) {
        return {remainingS: null, elapsedS: null, homeFinishS: null};
    }
    const remainingS = remainingOf(v);
    // In a mass start with a known start the field's clocks run from the gun (contextOf), so
    // yours must here too: the result's clock. When that is not known (a late join, the gun not
    // found) there is no race time of yours to set against a finisher's, and the outlook falls
    // back to the gaps; the clock from the line still serves for the early gate.
    const lineS = Number.isFinite(v?.race?.elapsedS) ? v.race.elapsedS : null;
    const byGun = v?.event?.kind === 'group' && v?.event?.startMs != null;
    const raceS = byGun ? (Number.isFinite(v?.race?.officialElapsedS) ? v.race.officialElapsedS : null) : lineS;
    const elapsedS = raceS ?? lineS;
    let homeFinishS = raceS != null && Number.isFinite(remainingS) ? raceS + remainingS : null;
    if (homeFinishS == null) {
        const home = list.find(r => r.isHome);
        homeFinishS = home?.finished && home.finishRaceS != null ? home.finishRaceS : null;
    }
    return {remainingS, elapsedS, homeFinishS};
}

/** The ids of an event's subgroups (Sauce's getEvent result), as strings; null when it lists none. */
export function eventSubgroupIdsOf(ev) {
    const ids = (Array.isArray(ev?.eventSubgroups) ? ev.eventSubgroups : []).map(g => g?.id).filter(id => id != null).map(String);
    return ids.length ? new Set(ids) : null;
}

/**
 * The gap a row shows: now (on the clock at your distance), or at the finish (the finish
 * outlook's predicted gap). Null for you and for a rider not compared; in the finish mode also
 * null while there is no outlook for the rider (no time to go yet): a gap now would read as one
 * at the finish.
 */
export function shownGapOf(r, outlookRider, mode) {
    if (r.isHome || !r.comparable) {
        return null;
    }
    return mode === 'finish' ? (outlookRider ? outlookRider.finishGapS : null) : r.gapS;
}

/**
 * The riders you can compare with (and you), in the order of the gap shown, each with
 * shownGapS: the gap now (the rows' own order), or at the finish once the outlook has settled
 * (the predicted gap, in the order of the predicted places). Before it settles the order stays
 * the gap now, so the place numbers read in order down the list.
 */
export function topRowsOf(list, {mode, outlook}) {
    const top = list.filter(r => r.isHome || r.comparable).map(r => ({
        ...r,
        shownGapS: r.isHome ? 0 : shownGapOf(r, outlook?.riders.get(r.id) ?? null, mode),
    }));
    if (mode === 'finish' && outlook?.settled) {
        top.sort((a, b) => (b.shownGapS ?? -1e9) - (a.shownGapS ?? -1e9));
    }
    return top;
}

/**
 * Sector boundaries in event metres: the plan's interval ends, when the plan is for this route.
 * Plan metres become event metres through the timing line: the event counts from the line,
 * which sits v.event.lineM into the plan (the course match once it has locked, else the file's
 * rule), and a game metre is k plan metres (route_m_per_game_m). The rider's manual offset is
 * inside the plan metre, so it comes out first. Ends at or before the line are not sectors.
 */
export function boundariesOf(v, plan) {
    if (!plan?.intervals?.length || v?.event?.routeMatches === false) {
        return null;
    }
    const offset = Number(v?.controls?.offsetM) || 0;
    const line = Number.isFinite(v?.event?.lineM) ? v.event.lineM : 0;
    const k = plan.routeMPerGameM > 0 ? plan.routeMPerGameM : 1;
    return [0, ...plan.intervals.map(iv => (iv.endM - offset - line) / k).filter(m => m > 0)];
}

/** "12 s", "4.2 s", "1:12" for a gap in seconds (no sign). Rounds first, so 9.96 s reads "10 s", 59.6 s "1:00". */
export function fmtGap(s) {
    const a = Math.abs(s);
    if (!Number.isFinite(a)) {
        return '';
    }
    if (a < 9.95) {
        return `${a.toFixed(1)} s`;
    }
    const r = Math.round(a);
    if (r < 60) {
        return `${r} s`;
    }
    return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

/** "4.2 s", "14 s" for a rate in seconds a minute (no sign): whole seconds from 10 s, so it fits the field's column. */
export function fmtRate(s) {
    const a = Math.abs(s);
    if (!Number.isFinite(a)) {
        return '';
    }
    return a < 9.95 ? `${a.toFixed(1)} s` : `${Math.round(a)} s`;
}

/**
 * Whether a rider is in play, from their finish-outlook entry (engine/finish-outlook.mjs):
 * 'target' when they are ahead of you now and at this pace you finish ahead of them or close
 * behind (beat, reach); 'threat' when they are behind you now and at this pace they finish
 * ahead of you or close behind (beaten, pressure); null when nothing is close either way
 * (clear: a rider falling away behind or pulling away ahead), or with no outlook.
 */
export function playOf(x) {
    if (x?.state === 'beat' || x?.state === 'reach') {
        return 'target';
    }
    if (x?.state === 'beaten' || x?.state === 'pressure') {
        return 'threat';
    }
    return null;
}

/**
 * The call the rivals strip shows for a rider: {play, faint}, or null. A rider is called only
 * once they have a pace (field-model: 90 s of shared history, the same pace the rate beside
 * them shows), or when they have finished: without one the outlook carries their gap as it
 * stands, which would call a rider you are losing on a target. faint until the outlook itself
 * has settled (20 minutes in, or 5 to go).
 */
export function playCall(x, {settled = false} = {}) {
    const play = playOf(x);
    if (!play) {
        return null;
    }
    return x.finished || Number.isFinite(x.paceSPerMin) ? {play, faint: !settled} : null;
}

/** The in-play call in words, for a tooltip: "at this pace you finish 4.2 s ahead of them: a target". */
export function playWords(x, {faint = false} = {}) {
    const play = playOf(x);
    if (!play || !Number.isFinite(x.finishGapS)) {
        return '';
    }
    const g = fmtGap(x.finishGapS);
    const at = x.finished ? 'against their finish time,' : 'at this pace';
    const how = x.finishGapS > 0 ? `${at} they finish ${g} ahead of you` : `${at} you finish ${g} ahead of them`;
    return `${how}: ${play === 'target' ? 'a target' : 'a threat'}${faint ? ' (early: the call settles 20 minutes in)' : ''}`;
}

export function shortName(name) {
    const parts = String(name ?? '').trim().split(/\s+/);
    if (parts.length < 2) {
        return parts[0] ?? '';
    }
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}
