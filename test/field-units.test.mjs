import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fmtGap, fmtRate, boundariesOf, shortName, playOf, playCall, playWords, contextOf, finishLineOf, outlookInputsOf, shownGapOf, topRowsOf, eventSubgroupIdsOf} from '../pages/src/views/field-units.mjs';
import {createField, ingest, rows, finishRaceOf} from '../pages/src/engine/field-model.mjs';
import {finishOutlook} from '../pages/src/engine/finish-outlook.mjs';
import {verdictText, seenWords} from '../pages/src/views/verdict.mjs';

test('fmtGap rounds before choosing the format, so no value outgrows its column', () => {
    assert.equal(fmtGap(4.24), '4.2 s');
    assert.equal(fmtGap(-9.94), '9.9 s');
    assert.equal(fmtGap(9.96), '10 s');          // was "10.0 s", too wide for the gap column
    assert.equal(fmtGap(42.4), '42 s');
    assert.equal(fmtGap(59.6), '1:00');          // was "60 s"
    assert.equal(fmtGap(72), '1:12');
    assert.equal(fmtGap(119.6), '2:00');         // was "1:60"
    assert.equal(fmtGap(NaN), '');
});

test('boundariesOf turns plan metres into event metres through the timing line', () => {
    const plan = {intervals: [{endM: 520}, {endM: 734}, {endM: 9275}], routeMPerGameM: 0.99856};
    // A plan whose metre 0 is the line (the measured line): event metres = plan metres / k.
    const atLine = boundariesOf({event: {lineM: 0}}, plan);
    assert.deepEqual(atLine.map(m => Math.round(m)), [0, 521, 735, 9288]);
    // A plan on the old axis, the course matched 160 m in: the first end is 360 m after the line.
    const old = boundariesOf({event: {lineM: 160}}, plan);
    assert.deepEqual(old.map(m => Math.round(m)), [0, 361, 575, 9128]);
    // Interval ends at or before the line are not sectors.
    assert.deepEqual(boundariesOf({event: {lineM: 600}}, {intervals: [{endM: 520}, {endM: 734}]}), [0, 134]);
    // The rider's manual offset comes out of the plan metre first.
    assert.deepEqual(boundariesOf({event: {lineM: 0}, controls: {offsetM: 20}}, {intervals: [{endM: 520}]}), [0, 500]);
    // Not this route, or no plan: no sectors.
    assert.equal(boundariesOf({event: {routeMatches: false}}, plan), null);
    assert.equal(boundariesOf({}, null), null);
});

test('shortName keeps the first initial and the rest', () => {
    assert.equal(shortName('Rider 14'), 'R. 14');
    assert.equal(shortName('Solo'), 'Solo');
});

test('fmtRate keeps one decimal under 10 s a minute and whole seconds from there', () => {
    assert.equal(fmtRate(0.6), '0.6 s');
    assert.equal(fmtRate(-2.44), '2.4 s');
    assert.equal(fmtRate(9.96), '10 s');           // "+14.3 s" was cut off in the field's column
    assert.equal(fmtRate(14.3), '14 s');
    assert.equal(fmtRate(NaN), '');
});

test('playOf colours only the riders in play: targets ahead, threats behind', () => {
    // Ahead now: you beat them at this pace, or finish close behind them: a target.
    assert.equal(playOf({state: 'beat'}), 'target');
    assert.equal(playOf({state: 'reach'}), 'target');
    // Behind now: they beat you at this pace, or finish close behind you: a threat.
    assert.equal(playOf({state: 'beaten'}), 'threat');
    assert.equal(playOf({state: 'pressure'}), 'threat');
    // Far behind and falling away, or far ahead and pulling away: not in play.
    assert.equal(playOf({state: 'clear'}), null);
    assert.equal(playOf(null), null);
});

test('playWords says how it ends at this pace and what that makes the rider', () => {
    assert.equal(playWords({state: 'beat', finishGapS: -4.2}), 'at this pace you finish 4.2 s ahead of them: a target');
    assert.equal(playWords({state: 'reach', finishGapS: 6}), 'at this pace they finish 6.0 s ahead of you: a target');
    assert.equal(playWords({state: 'pressure', finishGapS: -3}, {faint: true}), 'at this pace you finish 3.0 s ahead of them: a threat (early: the call settles 20 minutes in)');
    assert.equal(playWords({state: 'beaten', finishGapS: 12, finished: true}), 'against their finish time, they finish 12 s ahead of you: a threat');
    assert.equal(playWords({state: 'clear', finishGapS: 40}), '');
});

test('playCall waits for a rider\'s pace, and is faint until the outlook settles', () => {
    // No pace yet: the outlook carries the gap as it stands, so no call (it would call riders you lose on targets).
    assert.equal(playCall({state: 'reach', paceSPerMin: null}, {settled: true}), null);
    // Paced: called; faint before the outlook settles (20 minutes in, or 5 to go).
    assert.deepEqual(playCall({state: 'beat', paceSPerMin: 2.3}, {settled: false}), {play: 'target', faint: true});
    assert.deepEqual(playCall({state: 'beaten', paceSPerMin: -1.2}, {settled: true}), {play: 'threat', faint: false});
    // A finished rider has a known time: no pace needed.
    assert.deepEqual(playCall({state: 'beaten', finished: true, paceSPerMin: null}, {settled: true}), {play: 'threat', faint: false});
    // Not in play: no call.
    assert.equal(playCall({state: 'clear', paceSPerMin: 3}, {settled: true}), null);
});

// ---- the pre-1.0 audit of the field and rivals (2026-11-26) ----

// What the engine's view shows of a race on Crit Cross: the plan's finish measured at 15266.6 plan
// metres (0.99856 plan metres a game metre, the line at 0), Sauce's own length 84 m long.
const crit = {finishSource: 'measured', finishM: 15266.6, lengthM: 15266.6, routeMPerGameM: 0.99856};
const critView = (event = {}, race = {}) => ({
    event: {kind: 'tt', subgroupId: '9', routeMatches: true, lineM: 0, lengthM: 15349, lengthFor: '9', ...event},
    race: {finishM: 15266.6, ...race},
    controls: {offsetM: 0},
});

test('the field finishes where the plan has a measured finish, not at Sauce\'s longer length', () => {
    const ctx = contextOf(critView(), crit);
    assert.ok(Math.abs(ctx.lengthM - 15266.6 / 0.99856) < 0.01, `finish ${ctx.lengthM} event metres`);
    assert.equal(ctx.lengthFor, '9');
    // The riders' finish times are at that line: 10 m/s from the line reaches 15288.6 m in 1528.9 s
    // (at Sauce's 15349 m it would be 1534.9 s, the 6 s the HUD does not have).
    const f = createField();
    const entry = (id, t, v) => ({
        athleteId: id, watching: id === 1, athlete: {sanitizedFullname: `R${id}`}, stats: {},
        state: {eventDistance: t * v, worldTime: t * 1000, time: Math.floor(t), speed: v * 3.6, eventSubgroupId: 9},
    });
    for (let t = 0; t <= 1700; t++) {
        ingest(f, [entry(1, t, 10), entry(2, t, 10.5)], t * 1000, ctx);
    }
    assert.ok(Math.abs(finishRaceOf(f.riders.get('1')) - 1528.9) < 1, `home ${finishRaceOf(f.riders.get('1'))}`);
    assert.ok(Math.abs(finishRaceOf(f.riders.get('2')) - 1456.0) < 1, `rider 2 ${finishRaceOf(f.riders.get('2'))}`);
    // Sauce's length stands when the plan has no measured finish, or it is not this route's.
    assert.equal(contextOf(critView(), {...crit, finishSource: null}).lengthM, 15349);
    assert.equal(contextOf(critView({routeMatches: false}), crit).lengthM, 15349);
    assert.equal(contextOf(critView(), {...crit, fromHere: {}}).lengthM, 15349);
    // The engine ends the race elsewhere (Sauce's length more than 500 m from the plan's finish: another race).
    assert.equal(contextOf(critView({}, {finishM: 18000}), crit).lengthM, 15349);
});

test('the rider\'s offset and the timing line come off the plan\'s finish, as for the sectors', () => {
    const v = critView({lineM: 160}, {finishM: 15426.6});
    v.controls.offsetM = 20;
    assert.ok(Math.abs(finishLineOf(v, {...crit, finishM: 15426.6}) - (15426.6 - 20 - 160) / 0.99856) < 0.01);
});

test('with no length from Sauce (a route newer than its build) the plan\'s finish is the finish', () => {
    const plan = {lengthM: 21155.5, routeMPerGameM: 1};
    const v = {event: {kind: 'tt', subgroupId: '7', routeMatches: true, lineM: 0, lengthM: null, lengthFor: null}, race: {finishM: 21155.5}, controls: {offsetM: 0}};
    const ctx = contextOf(v, plan);
    assert.equal(ctx.lengthM, 21155.5);
    assert.equal(ctx.lengthFor, '7', 'for the category the plan is racing in');
    const f = createField();
    for (let t = 0; t <= 2200; t++) {
        const e = id => ({
            athleteId: id, watching: id === 1, athlete: {}, stats: {},
            state: {eventDistance: t * 10 * (id === 1 ? 1 : 1.02), worldTime: t * 1000, time: t, speed: 36, eventSubgroupId: 7},
        });
        ingest(f, [e(1), e(2)], t * 1000, ctx);
    }
    assert.ok(f.riders.get('1').finished && f.riders.get('2').finished, 'both finished, with no length from Sauce');
    assert.ok(Math.abs(finishRaceOf(f.riders.get('1')) - 2115.55) < 1);
    const list = rows(f, {nowMs: 2200_000});
    assert.equal(list.find(x => x.isHome).finishPlace, 2);
    // Not a plan for this route, or no plan at all: still no finish.
    assert.equal(contextOf({...v, event: {...v.event, routeMatches: false}}, plan).lengthM, null);
    assert.equal(contextOf(v, null).lengthM, null);
});

test('spectating: the finish outlook has no numbers (your race stopped where it was) and you stay home', () => {
    const v = {status: 'racing', spectating: {athleteId: '2', name: 'Other'}, race: {running: true, remainingS: 725.6, elapsedS: 1352, finishM: 21000}, event: {}};
    assert.deepEqual(outlookInputsOf(v, []), {remainingS: null, elapsedS: null, homeFinishS: null});
    assert.equal(finishOutlook([], outlookInputsOf(v, [])), null, 'no outlook, so no verdict or colours');
    assert.equal(contextOf(v, null).spectating, true);
    assert.equal(contextOf({...v, spectating: null}, null).spectating, false);
    // Not spectating: the same view gives its time to go.
    assert.equal(outlookInputsOf({...v, spectating: null}, []).remainingS, 725.6);
});

test('"at the finish" shows nothing while there is no outlook, not the gap now under that heading', () => {
    const rider = {id: 'a', isHome: false, comparable: true, gapS: 7.5};
    assert.equal(shownGapOf(rider, null, 'finish'), null);
    assert.equal(shownGapOf(rider, {finishGapS: 3.2}, 'finish'), 3.2);
    assert.equal(shownGapOf(rider, null, 'clock'), 7.5);
    assert.equal(shownGapOf({...rider, isHome: true}, null, 'clock'), null);
    assert.equal(shownGapOf({...rider, comparable: false}, null, 'clock'), null);
});

test('at the finish, the rows sort by the predicted gap only once the outlook has settled, so the place numbers read in order', () => {
    const rider = (id, gapS, place) => ({id, isHome: false, comparable: true, gapS, place});
    const list = [rider('a', 9, 1), {id: 'home', isHome: true, comparable: true, gapS: 0, place: 2}, rider('b', -3, 3)];
    const outlook = settled => ({settled, riders: new Map([['a', {finishGapS: -4}], ['b', {finishGapS: 6}]])});
    const ids = top => top.map(r => r.id).join(',');
    // Early: the rows keep the order of the gap now (the place column is the place now).
    assert.equal(ids(topRowsOf(list, {mode: 'finish', outlook: outlook(false)})), 'a,home,b');
    // Settled: the predicted order, with predicted places.
    assert.equal(ids(topRowsOf(list, {mode: 'finish', outlook: outlook(true)})), 'b,home,a');
    // The gap now: always the rows' order.
    assert.equal(ids(topRowsOf(list, {mode: 'clock', outlook: outlook(true)})), 'a,home,b');
    assert.deepEqual(topRowsOf(list, {mode: 'finish', outlook: outlook(false)}).map(r => r.shownGapS), [-4, 0, 6]);
});

test('an event\'s subgroup ids come from Sauce\'s event, as strings', () => {
    assert.deepEqual([...eventSubgroupIdsOf({eventSubgroups: [{id: 7457944}, {id: 7457948}, {name: 'no id'}]})], ['7457944', '7457948']);
    assert.equal(eventSubgroupIdsOf({eventSubgroups: []}), null);
    assert.equal(eventSubgroupIdsOf(null), null);
});

test('the finish count says what it counts: the riders seen to cross, not the event', () => {
    assert.equal(seenWords(38), 'of 38 seen so far');
    assert.equal(seenWords(32, {short: true}), 'of 32 seen');
});

test('the chase line stops saying how much faster catches them in the last 30 seconds', () => {
    const list = [{id: 'home', name: 'You', isHome: true, comparable: true, gapS: 0, place: 5, finished: false},
        {id: 'a', name: 'Sam Patel', isHome: false, comparable: true, gapS: 4, paceSPerMin: 0, paceSpanS: 240, homeSinceS: 0, finished: false, finishRaceS: null}];
    const detail = remainingS => verdictText(finishOutlook(list, {remainingS, elapsedS: 1500, homeFinishS: 1500 + remainingS})).detail;
    assert.match(detail(60), /^S\. Patel 4\.0 s up at the finish: 4\.0 s a minute faster catches them$/);
    assert.equal(detail(10), 'S. Patel 4.0 s up at the finish');
});
