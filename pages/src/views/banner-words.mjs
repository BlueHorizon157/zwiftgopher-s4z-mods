// The words of the HUD's banner line (hud.mjs setBanner): what the rider is told above the figures
// when something other than the race itself needs saying, and the plan panel's hint. Pure, so
// test/ui-audit.test.mjs runs them in Node. The strip has room for the whole sentence; the stack and the dial (narrow) get a short
// one that is never cut mid-word, with the long form in the tooltip (tip).
import {fmtTime} from './dom.mjs';
import {hereWords} from './from-here.mjs';

/** "event 16.15 km, plan 22.42 km": the two lengths, the plan's second. */
export function mismatchWords(v) {
    const km = m => `${(m / 1000).toFixed(2)} km`;
    const eventM = v.event?.lengthM;
    const planM = v.plan?.lengthM ?? v.race?.lengthM;
    return `event ${km(eventM)}, plan ${km(planM)}`;
}

/** What the narrow layouts say for a plan of another length: the figures are in the tooltip. */
export const MISMATCH_SHORT = 'wrong plan length';

function mismatchTip(v) {
    return `This plan is for another length than the event (${mismatchWords(v)}). The finish is predicted at the event's end.`;
}

/** "plan off by 429 m": the plan's timing line is not where the road has it (short for the narrow layouts; the tip says what follows). */
export function outOfStepWords(stepM) {
    return `plan off by ${Math.round(Math.abs(stepM))} m`;
}

export function outOfStepTip(stepM) {
    const m = Math.round(Math.abs(stepM));
    return stepM > 0
        ? `This plan starts ${m} m before this race's timing line, so the last ${m} m of the race are not in it. The targets follow the road. Make the plan again for the next race.`
        : `This plan starts ${m} m after this race's timing line, so the first ${m} m of the race are not in it. The targets follow the road. Make the plan again for the next race.`;
}

/**
 * {text, name, tip} for the banner. text is plain words and name the route (or rider) set apart in
 * the strip; both are escaped by the caller. now: Date.now(). idleStatus: statusWords(v) and
 * idleNext: the next time trial in words (or ''), for a plan loaded while nothing is happening.
 */
export function bannerWords(v, {narrow = false, now = Date.now(), idleStatus = '', idleNext = ''} = {}) {
    let text = '';
    let name = '';
    let tip = '';
    const route = v.plan?.routeName ? ` ${v.plan.routeName}` : '';
    if (v.spectating) {
        // The dial has no room for a name beside the words: one string, cut by an ellipsis, not mid-word.
        const who = v.spectating.name ?? 'another rider';
        if (narrow) {
            text = `spectating ${who}`;
        } else {
            text = 'spectating ';
            name = who;
        }
    } else if (v.status === 'finished') {
        text = 'finished';
        name = route;
    } else if (v.status === 'armed') {
        const startMs = v.event?.startMs;
        if (v.event?.inEvent && startMs && startMs > now) {
            text = `starts in ${fmtTime((startMs - now) / 1000)}`;
        } else if (v.event?.inEvent && v.event.kind === 'group') {
            // Short, so the strategy chip stays in view on the narrow layouts; the words are in the tip.
            text = 'ready, mass start';
            tip = 'Mass start: the game starts its distance at a timing line a little way out of the pen, and the plan starts there. The result counts from the gun.';
        } else if (v.event?.inEvent) {
            text = narrow ? 'ready, waiting' : 'ready, waiting for the start';
            tip = narrow ? 'Ready, waiting for the start: the clock starts when you cross the timing line.' : '';
        } else {
            text = 'ready';
        }
        if (Number.isFinite(v.event?.mismatchM)) {
            text = narrow ? MISMATCH_SHORT : `${text}, ${mismatchWords(v)}`;
            tip = narrow ? mismatchTip(v) : tip;
        }
        name = route;
    } else if (v.status === 'idle' && v.plan) {
        if (narrow) {
            // The route name is the banner's name (the stack shows it, the dial has no room); the
            // next time trial is in the tooltip.
            text = idleStatus;
            name = route;
            tip = idleNext ? `Next TT: ${idleNext}` : '';
        } else {
            text = `${v.plan.routeName ?? 'plan'}: ${idleStatus}`;
            if (idleNext) {
                text += ` · next TT ${idleNext}`;
            }
        }
    } else if (v.status === 'racing' && v.plan?.fromHere) {
        text = narrow ? 'from here' : hereWords(v.plan.fromHere);
        tip = narrow ? hereWords(v.plan.fromHere) : '';
    } else if (v.status === 'racing' && Number.isFinite(v.event?.mismatchM)) {
        // A plan for another distance (say one lap planned, 16 km raced)
        // stays flagged for the whole race; the finish is predicted to the event's end.
        text = narrow ? MISMATCH_SHORT : mismatchWords(v);
        tip = narrow ? mismatchTip(v) : '';
    } else if (v.status === 'racing' && Number.isFinite(v.race?.alignment?.outOfStepM)) {
        // The plan was laid out with its timing line elsewhere (say 429 m of padding the
        // planner drew before the start). The road places the targets; the rider is told.
        text = outOfStepWords(v.race.alignment.outOfStepM);
        tip = outOfStepTip(v.race.alignment.outOfStepM);
    } else if (v.status === 'racing' && v.race?.alignment?.unmatched) {
        text = narrow ? 'course not matched' : 'course not matched: targets by distance';
        tip = 'The road you are on has not been matched to the plan\'s course, so the targets change by distance from the timing line alone.';
    } else if (v.status === 'racing' && v.event?.inEvent && v.event.kind === 'group') {
        const gunS = v.race?.gunToLineS;
        text = gunS != null ? `gun to line ${fmtTime(gunS)}` : 'clock from the line';
        tip = gunS != null
            ? `Mass start: the result counts from the gun. You crossed the timing line ${fmtTime(gunS)} after it, and the finish time includes that. The plan and ahead or behind run from the line.`
            : 'Mass start: the result counts from the gun, which is not known here. The times shown run from the timing line.';
    }
    return {text, name, tip};
}

/**
 * The plan panel's hint under the strategy buttons, for a plan that is loaded: what the buttons do
 * now (before the start, racing: the targets change in place, after the finish: for the next ride),
 * and nothing about strategies for a plan that has only one. Esc keeps the plan in every case.
 */
export function planPanelHint({status, beforeStart, choose}) {
    if (beforeStart) {
        return choose ? 'Pick a strategy, or enter another code. Esc keeps this plan.' : 'Enter another code. Esc keeps this plan.';
    }
    if (status === 'racing') {
        return choose ? 'Pick a strategy: the targets change now, the clock and W\u2032 carry on. Esc keeps this plan.' : 'This plan has no other strategy. Esc keeps this plan.';
    }
    return choose
        ? 'A strategy picked now is for the next ride. Esc keeps this plan.'
        : 'Esc keeps this plan.';
}
