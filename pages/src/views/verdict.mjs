// The finish outlook's verdict in words (engine/finish-outlook.mjs), for the field window's
// header and the rivals strip's middle: a word for the kind, a headline and the detail. Shown
// only once the outlook is settled (the early kind is for the windows to leave out).
import {fmtGap, shortName} from './field-feed.mjs';

export const VERDICT_WORD = {early: 'early', done: 'finished', clear: 'clear', defend: 'defend', chase: 'chase', contested: 'contested'};

/** {word, headline, detail} for an outlook (null without one). */
export function verdictText(o) {
    const v = o?.verdict;
    if (!v) {
        return null;
    }
    const place = o.home.place;
    const pred = o.home.predictedPlace;
    const finished = o.home.finishPlace;
    const x = v.rider;
    const who = x ? shortName(x.name) : '';
    const more = v.others > 0 ? ` (+${v.others})` : '';
    const g = s => (Math.abs(s) < 1 ? '<1 s' : fmtGap(s));
    let headline = '';
    let detail = '';
    switch (v.kind) {
    case 'early':
        headline = 'Too early to tell';
        detail = 'how the finish is shaping up needs a few minutes of racing';
        break;
    case 'done':
        headline = finished ? `Finished ${ordinal(finished)}` : place ? `Finished ${ordinal(place)}` : 'Finished';
        detail = 'riders still out can change it';
        break;
    case 'clear': {
        headline = 'Clear';
        const sides = [v.upS != null ? `${g(v.upS)} up` : '', v.backS != null ? `${g(v.backS)} back` : ''].filter(Boolean).join(', ');
        detail = `${sides ? `${sides} at the finish: ` : ''}ride your plan`;
        break;
    }
    case 'defend':
        headline = place ? `Defend ${ordinal(place)}` : 'Defend';
        detail = x.state === 'beaten'
            ? `${who} beats you by ${g(x.finishGapS)}${more}`
            : `${who} ${g(x.finishGapS)} back at the finish${x.paceSPerMin <= -0.3 ? `, closing at ${Math.abs(x.paceSPerMin).toFixed(1)} s a minute` : ''}${more}`;
        break;
    case 'chase':
        if (x.state === 'beat') {
            headline = pred ? `On for ${ordinal(pred)}` : 'Gaining';
            detail = `you beat ${who} by ${g(x.finishGapS)}${more}`;
        } else {
            headline = Number.isFinite(x.place) ? `Chase ${ordinal(x.place)}` : 'Chase';
            detail = `${who} ${g(x.finishGapS)} up at the finish${x.needSPerMin != null ? `: ${x.needSPerMin.toFixed(1)} s a minute faster catches them` : ''}${more}`;
        }
        break;
    case 'contested':
        headline = 'Contested';
        detail = v.lo != null && v.hi != null && v.hi > v.lo
            ? `${ordinal(v.lo)} to ${ordinal(v.hi)} within ${g(v.spreadS)}`
            : `${v.others + 1} riders within ${g(v.spreadS)}`;
        break;
    }
    return {word: VERDICT_WORD[v.kind], kind: v.kind, headline, detail};
}

/** "1st", "2nd", "11th", "23rd". */
export function ordinal(n) {
    const t = n % 100;
    const s = t >= 11 && t <= 13 ? 'th' : {1: 'st', 2: 'nd', 3: 'rd'}[n % 10] ?? 'th';
    return `${n}${s}`;
}
