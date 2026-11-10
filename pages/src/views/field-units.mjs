// Pure helpers for the field window and the rivals strip (no Sauce, no DOM), so they can be
// tested in node. views/field-feed.mjs re-exports them.

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
