// The finish outlook (pages/src/engine/finish-outlook.mjs) on the clock: gaps carried to the line
// at the pace of the last minutes, the states, the places at the finish (no clamp, no Zwift input),
// the early gate, the finished riders, and the verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import {finishOutlook, OUTLOOK} from '../pages/src/engine/finish-outlook.mjs';

// A row as field-model rows() gives it: the clock gap (+ ahead of you), the pace (+ you gain on
// them), seconds of pace history.
const r = (id, gapS, paceSPerMin, paceSpanS = 240) => ({
    id, name: `Rider ${id}`, isHome: false, comparable: true, stale: false, gapS, clockS: gapS,
    paceSPerMin, paceSpanS, finished: false, finishRaceS: null,
});
const home = (extra = {}) => ({id: 'home', name: 'You', isHome: true, comparable: true, stale: false, gapS: 0, clockS: 0, finished: false, ...extra});
// Settled: past the gate (20 minutes of racing).
const SETTLED = {elapsedS: 1500};

test('no time to go, no outlook', () => {
    assert.equal(finishOutlook([r('a', 5, 1)], {remainingS: null}), null);
});

test('the early gate: no places or verdict before 20 minutes of racing, nor with 5 minutes to go, but states are kept', () => {
    const list = [home(), r('a', 4, 0), r('b', -4, 0)];
    const early = finishOutlook(list, {remainingS: 1200, elapsedS: 600});
    assert.equal(early.settled, false);
    assert.equal(early.verdict.kind, 'early');
    assert.equal(early.home.predictedPlace, null);
    assert.equal(early.riders.get('a').place, null);
    assert.equal(early.riders.get('a').early, true);
    assert.equal(early.riders.get('a').state, 'reach', 'the state is still worked out');
    assert.equal(early.home.place, 2, 'your place now is not gated: one rider ahead on the clock, so second');
    const settledLate = finishOutlook(list, {remainingS: 280, elapsedS: 600});
    assert.equal(settledLate.settled, true, 'five minutes or less to go is settled');
    assert.ok(settledLate.home.predictedPlace != null);
    assert.equal(OUTLOOK.gateElapsedS, 1200);
    assert.equal(OUTLOOK.gateToGoS, 300);
    assert.equal(finishOutlook(list, {remainingS: 600, elapsedS: 1199.5}).settled, false, 'just short of the gate');
    assert.equal(finishOutlook(list, {remainingS: 600, elapsedS: 1200}).settled, true, 'at the gate');
});

test('states from the gap at the finish, close shrinking with the time to go', () => {
    // 10 min to go: close is 10 s.
    const o = finishOutlook([
        home(),
        r('beat', 6, 1),          // 6 - 10 = 4 s behind you at the finish
        r('reach', 15, 1),        // 5 s ahead at the finish
        r('far', 40, 1),          // 30 s: clear
        r('beaten', -4, -1),      // they finish 6 s ahead of you
        r('press', -12, -0.5),    // 7 s behind at the finish
        r('gone', -8, 2),         // you ride away: 28 s
        r('nopace', 3, null, 0),  // no pace: held at 3 s, close, early
    ], {remainingS: 600, ...SETTLED});
    const st = id => o.riders.get(id).state;
    assert.deepEqual(['beat', 'reach', 'far', 'beaten', 'press', 'gone', 'nopace'].map(st),
        ['beat', 'reach', 'clear', 'beaten', 'pressure', 'clear', 'reach']);
    assert.equal(o.closeS, 10);
    assert.ok(o.riders.get('nopace').early);
    assert.ok(!o.riders.get('reach').early);
    assert.ok(Math.abs(o.riders.get('reach').needSPerMin - 0.5) < 1e-9, '5 s over 10 min');
    // With 2 min to go close is 5 s (the floor).
    assert.equal(finishOutlook([home(), r('x', 7, 0)], {remainingS: 120, ...SETTLED}).riders.get('x').state, 'clear');
    assert.equal(finishOutlook([home(), r('x', 4, 0)], {remainingS: 120, ...SETTLED}).riders.get('x').state, 'reach');
    // A short pace history is early.
    assert.ok(finishOutlook([home(), r('x', 4, 1, 120)], {remainingS: 600, ...SETTLED}).riders.get('x').early);
});

test('the gap moves until the one of you further back on the road reaches the line (Dave, 2026-11-14)', () => {
    // 20 s up on the clock, you gain 5 s a minute, 1 minute to go.
    const at = (homeSinceS, gapS = 20, pace = 5) => ({...r('x', gapS, pace), homeSinceS});
    const near = finishOutlook([home(), at(0)], {remainingS: 60, ...SETTLED}).riders.get('x');
    // Ahead of you on the road (or level): the gap is measured where you are; one minute left to close it.
    assert.equal(near.finishGapS, 15);
    assert.equal(near.state, 'clear', 'out of reach');
    // Behind you on the road with a long way left: you rode the 4 minutes from their place to yours,
    // so the gap goes on closing for 5 minutes in all, and you beat them.
    const far = finishOutlook([home(), at(240)], {remainingS: 60, ...SETTLED}).riders.get('x');
    assert.equal(far.finishGapS, -5);
    assert.equal(far.state, 'beat');
    assert.equal(far.needSPerMin, 5, 'what it takes from you is on your own minute');
    // A threat the same way: 20 s down, they gain 5 s a minute and still have 5 minutes to ride.
    const threat = finishOutlook([home(), at(240, -20, -5)], {remainingS: 60, ...SETTLED}).riders.get('x');
    assert.equal(threat.finishGapS, 5);
    assert.equal(threat.state, 'beaten');
    assert.equal(finishOutlook([home(), at(0, -20, -5)], {remainingS: 60, ...SETTLED}).riders.get('x').state, 'clear', 'not when you are the one further back');
    // Close is on the minutes still to be compared: 10 s up with 1 minute to go is clear for a
    // rider beside you on the road (close is 5 s) but close for one with 10 minutes to ride.
    assert.equal(finishOutlook([home(), at(0, 10, 0)], {remainingS: 60, ...SETTLED}).riders.get('x').state, 'clear');
    assert.equal(finishOutlook([home(), at(540, 10, 0)], {remainingS: 60, ...SETTLED}).riders.get('x').state, 'reach');
});

test('once you have finished, a rider still on the road behind you is carried over their stretch, not frozen', () => {
    const x = {...r('x', 10, 4), homeSinceS: 180};
    const o = finishOutlook([home({finished: true, finishRaceS: 1900}), x], {remainingS: 0, homeFinishS: 1900});
    assert.equal(o.riders.get('x').finishGapS, -2, '10 s up, 3 minutes left at 4 s a minute');
    assert.equal(o.home.predictedPlace, 1);
});

test('states hold past their line so a rider on the edge does not flicker', () => {
    const prev = finishOutlook([home(), r('a', 5, 1.2)], {remainingS: 600, ...SETTLED});   // -7: beat
    assert.equal(prev.riders.get('a').state, 'beat');
    assert.equal(finishOutlook([home(), r('a', 5, 0.55)], {remainingS: 600, ...SETTLED, prev}).riders.get('a').state, 'beat', '-0.5 s holds');
    assert.equal(finishOutlook([home(), r('a', 5, 0.55)], {remainingS: 600, ...SETTLED}).riders.get('a').state, 'reach', 'not beat from fresh');
    const near = finishOutlook([home(), r('b', -10, 0)], {remainingS: 600, ...SETTLED});
    assert.equal(near.riders.get('b').state, 'pressure');
    assert.equal(finishOutlook([home(), r('b', -12, 0)], {remainingS: 600, ...SETTLED, prev: near}).riders.get('b').state, 'pressure', 'within 25 %');
    assert.equal(finishOutlook([home(), r('b', -12, 0)], {remainingS: 600, ...SETTLED}).riders.get('b').state, 'clear');
});

test('places at the finish: 1 + the riders finishing ahead of you, and each rider\'s own place', () => {
    const o = finishOutlook([
        home(),
        r('p2', 20, 0),           // stays ahead
        r('p3', 3, 1),            // you beat: 7 s behind at the finish
        r('p5', -2, -1),          // beats you: 8 s ahead
        r('p6', -30, 0),
    ], {remainingS: 600, homeFinishS: 1800, ...SETTLED});
    // Ahead of you at the finish: p2 (20 s), p5 (8 s). Nobody else.
    assert.equal(o.home.predictedPlace, 3, 'two finish ahead of you');
    const place = id => o.riders.get(id).place;
    assert.deepEqual(['p2', 'p5', 'p3', 'p6'].map(place), [1, 2, 4, 5]);
    assert.equal(o.riders.get('p5').finishS, 1792);
    assert.equal(o.riders.get('p3').finishS, 1807);
});

test('no clamp: eight riders ahead of you on the clock are places 1 to 8, and you are 9th', () => {
    const riders = [1, 2, 3, 4, 5, 6, 7, 8].map(i => r(`ahead${i}`, 10 + i * 4, 0));
    const o = finishOutlook([home(), ...riders], {remainingS: 600, ...SETTLED});
    const places = riders.map(x => o.riders.get(x.id).place).sort((a, b) => a - b);
    assert.deepEqual(places, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(o.home.predictedPlace, 9);
    // The rider furthest ahead on the clock finishes furthest ahead: place 1.
    assert.equal(o.riders.get('ahead8').place, 1);
    assert.equal(o.riders.get('ahead1').place, 8);
});

test('a finished rider is at their real finish: your predicted finish, less theirs', () => {
    // You are at 1000 s, racing on to 1800 s; a rider finished in 1750 s, twenty seconds ahead of you now.
    const finished = {...r('f', 20, 0), finished: true, finishRaceS: 1750};
    const o = finishOutlook([home(), finished], {remainingS: 800, elapsedS: 1000, homeFinishS: 1800, ...SETTLED});
    const f = o.riders.get('f');
    assert.equal(f.finished, true);
    assert.equal(f.finishGapS, 50, 'you would finish 50 s behind them');
    assert.equal(f.finishS, 1750);
    assert.equal(f.early, false);
    assert.equal(f.place, 1, 'they finish ahead of you');
    assert.equal(o.home.predictedPlace, 2, 'so you are second');
    assert.equal(f.state, 'clear', 'and not close: nothing to think about');
});

test('you have finished: done, with your place among the finishers', () => {
    const o = finishOutlook([
        home({finished: true, finishRaceS: 1795, finishPlace: 2, finishers: 3}),
        {...r('a', -30, 0), finished: true, finishRaceS: 1700},
        {...r('b', 12, 0), finished: true, finishRaceS: 1830},
    ], {remainingS: 0, elapsedS: 1795});
    assert.equal(o.verdict.kind, 'done');
    assert.equal(o.home.finishPlace, 2);
    assert.equal(o.home.finishers, 3);
    assert.equal(o.riders.get('a').place, 1, 'they finished first');
    assert.equal(o.riders.get('b').place, 3, 'they finished after you');
});

test('verdicts', () => {
    const v = (list, opts = {}) => finishOutlook(list, {remainingS: 600, ...SETTLED, ...opts}).verdict;
    assert.equal(v([home(), r('a', 40, 0), r('b', -40, 0)]).kind, 'clear');
    const clear = v([home(), r('a', 40, 0), r('b', -25, 0)]);
    assert.equal(clear.upS, 40);
    assert.equal(clear.backS, 25);
    const defend = v([home(), r('a', -6, -0.2), r('b', -9, -0.1)]);
    assert.equal(defend.kind, 'defend');
    assert.equal(defend.rider.id, 'a', 'the closest threat first');
    assert.equal(defend.others, 1);
    assert.equal(v([home(), r('a', -4, -1)]).rider.state, 'beaten', 'one who beats you comes first');
    assert.equal(v([home(), r('a', 8, 0)]).kind, 'chase');
    const contested = v([home(), r('a', 8, 0), r('b', -3, 0)]);
    assert.equal(contested.kind, 'contested');
    assert.deepEqual([contested.lo, contested.hi], [1, 3], 'the places in contention: a first, b third, you second');
    assert.equal(contested.spreadS, 8);
    assert.equal(v([home(), r('a', 8, null, 0)]).kind, 'early', 'no pace from anyone yet');
    assert.equal(v([home(), r('a', 8, 1)], {remainingS: 0}).kind, 'done');
    assert.equal(v([home(), r('a', 8, 1)], {elapsedS: 300}).kind, 'early', 'before the gate');
});

// ---- the pre-1.0 audit of the field and rivals (2026-11-26) ----

test('the verdict calls only riders with a pace (or finished), as the rivals strip does', () => {
    // Rider 2 is clear with a pace; rider 3 has just come into view 3 s behind with no pace yet.
    const list = [home(), r('2', 60, 0.2), r('3', -3, null, 0)];
    const o = finishOutlook(list, {remainingS: 280, elapsedS: 1300, homeFinishS: 1580});
    assert.equal(o.riders.get('3').state, 'pressure', 'the rider is still at their gap as it stands');
    assert.equal(o.riders.get('3').early, true);
    assert.equal(o.verdict.kind, 'clear', 'but nobody is called on a gap with no pace');
    assert.equal(o.verdict.backS, null, 'and the clear line does not count them either');
    // Once they have a pace they are called.
    const paced = finishOutlook([home(), r('2', 60, 0.2), r('3', -3, -0.2, 120)], {remainingS: 280, elapsedS: 1300, homeFinishS: 1580});
    assert.equal(paced.verdict.kind, 'defend');
    assert.equal(paced.verdict.rider.id, '3');
    // Nobody with a pace: too early to tell, as before.
    assert.equal(finishOutlook([home(), r('3', -3, null, 0)], {remainingS: 280, elapsedS: 1300, homeFinishS: 1580}).verdict.kind, 'early');
});

test('"s a minute faster catches them" is not worked out in the last 30 seconds (it grows without limit)', () => {
    const list = [home(), r('a', 4, 0)];
    const need = remainingS => finishOutlook(list, {remainingS, elapsedS: 1500, homeFinishS: 1500 + remainingS}).riders.get('a').needSPerMin;
    assert.equal(OUTLOOK.needMinS, 30);
    assert.equal(need(60), 4);
    assert.equal(need(30), 8);
    assert.equal(need(29), null);
    assert.equal(need(1), null);
});
