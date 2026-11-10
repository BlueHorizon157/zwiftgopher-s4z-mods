// Sauce's `nearby` list into the field model (engine/field-model.mjs) for the field window and the
// rivals strip. The window's own engine says what kind of event it is, where the timing line
// is and where the plan's sectors end; this converts those from plan metres to event metres.
import * as sauce from '../sauce.mjs';
import {createField, ingest, resetField} from '../engine/field-model.mjs';
import {remainingOf} from './race-time.mjs';

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
    // Every rider's eventDistance sits at zero until the timing line, so in event metres
    // the line is 0, whatever the route (docs/REVAMP_PLAN.md 6.2). The event's length is the
    // line you finish at: a rider who passes it is finished (field-model.mjs).
    return {lineM: 0, kind: v?.event?.kind ?? null, gunMs: v?.event?.startMs ?? null, lengthM: v?.event?.lengthM ?? null};
}

/**
 * The finish outlook's inputs from the window's view and the rows: your time to go, your race
 * time so far, and your race time at the finish (now plus the time to go; once you are through,
 * your own finish). Null where not known.
 */
export function outlookInputsOf(v, list) {
    const remainingS = remainingOf(v);
    const elapsedS = Number.isFinite(v?.race?.elapsedS) ? v.race.elapsedS : null;
    let homeFinishS = elapsedS != null && Number.isFinite(remainingS) ? elapsedS + remainingS : null;
    if (homeFinishS == null) {
        const home = list.find(r => r.isHome);
        homeFinishS = home?.finished && home.finishRaceS != null ? home.finishRaceS : null;
    }
    return {remainingS, elapsedS, homeFinishS};
}

// The pure helpers live in field-units.mjs (testable in node); re-exported here for the windows.
export {boundariesOf, fmtGap, fmtRate, playCall, playOf, playWords, shortName} from './field-units.mjs';
