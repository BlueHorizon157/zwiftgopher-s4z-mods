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

// The pure helpers live in field-units.mjs (testable in node); re-exported here for the windows.
export {boundariesOf, fmtGap, fmtRate, playCall, playOf, playWords, shortName} from './field-units.mjs';
