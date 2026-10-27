// Sauce's `nearby` list into the field model (engine/field.mjs) for the field window and the
// rivals strip. The window's own engine says what kind of event it is, where the timing line
// is and where the plan's sectors end; this converts those from plan metres to event metres.
import * as sauce from '../sauce.mjs';
import {createField, ingest, resetField} from '../engine/field.mjs';
import {DEFAULT_PEN_M, START_DELAY_M} from '../engine/clock.mjs';

export function startFieldFeed({view, onUpdate = null}) {
    const field = createField();
    sauce.subscribe('nearby', list => {
        ingest(field, list, Date.now(), contextOf(view()));
        onUpdate?.();
    }, {record: true});
    return {
        field,
        reset: () => resetField(field),
    };
}

export function contextOf(v) {
    const offset = v?.controls?.offsetM ?? 0;
    const lineM = (v?.event?.lineM ?? DEFAULT_PEN_M + START_DELAY_M) - offset;
    return {lineM, kind: v?.event?.kind ?? null, gunMs: v?.event?.startMs ?? null};
}

/** Sector boundaries in event metres: the plan's interval ends, when the plan is for this route. */
export function boundariesOf(v, plan) {
    if (!plan?.intervals?.length || v?.event?.routeMatches === false) {
        return null;
    }
    const offset = v?.controls?.offsetM ?? 0;
    return [0, ...plan.intervals.map(iv => iv.endM - offset)];
}

/** "12 s", "4.2 s", "1:12" for a gap in seconds (no sign). */
export function fmtGap(s) {
    const a = Math.abs(s);
    if (!Number.isFinite(a)) {
        return '';
    }
    if (a < 10) {
        return `${a.toFixed(1)} s`;
    }
    if (a < 60) {
        return `${Math.round(a)} s`;
    }
    const m = Math.floor(a / 60);
    return `${m}:${String(Math.round(a - m * 60)).padStart(2, '0')}`;
}

export function shortName(name) {
    const parts = String(name ?? '').trim().split(/\s+/);
    if (parts.length < 2) {
        return parts[0] ?? '';
    }
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}
