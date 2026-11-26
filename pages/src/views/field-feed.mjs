// Sauce's `nearby` list into the field model (engine/field-model.mjs) for the field window and the
// rivals strip. The window's own engine says what kind of event it is, where the timing line
// is and where the plan's sectors end; this converts those from plan metres to event metres.
import * as sauce from '../sauce.mjs';
import {createField, ingest, resetField} from '../engine/field-model.mjs';
import {fetchEventInfo} from '../eventinfo.mjs';
import {contextOf, eventSubgroupIdsOf} from './field-units.mjs';

export function startFieldFeed({view, plan = () => null, onUpdate = null}) {
    const field = createField();
    const subgroups = new Map();
    sauce.subscribe('nearby', list => {
        ingest(field, list, Date.now(), contextOf(view(), plan()));
        eventSubgroupsOf(field, subgroups);
        onUpdate?.();
    }, {record: true});
    return {
        field,
        reset: () => resetField(field),
    };
}

// The subgroups of the event you are in, asked once per category, for "every category": only its
// own riders. Best effort: until the list is in (or if it never comes) the field falls back to the
// riders seen since your category began (field-model.mjs inCurrentEvent).
function eventSubgroupsOf(field, known) {
    if (field.subgroupId == null) {
        return;
    }
    const key = String(field.subgroupId);
    if (!known.has(key)) {
        known.set(key, null);
        fetchEventInfo(field.subgroupId)
            .then(info => (info?.eventId != null ? sauce.rpc.getEvent(Number(info.eventId)) : null))
            .then(ev => known.set(key, eventSubgroupIdsOf(ev)))
            .catch(() => {});
    }
    field.eventSubgroupIds = known.get(key);
}

// The pure helpers live in field-units.mjs (testable in node); re-exported here for the windows.
export {contextOf, outlookInputsOf, finishLineOf, topRowsOf, shownGapOf, boundariesOf, fmtGap, fmtRate, playCall, playOf, playWords, shortName} from './field-units.mjs';
