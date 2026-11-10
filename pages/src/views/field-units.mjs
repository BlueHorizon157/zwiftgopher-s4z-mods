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

export function shortName(name) {
    const parts = String(name ?? '').trim().split(/\s+/);
    if (parts.length < 2) {
        return parts[0] ?? '';
    }
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}
