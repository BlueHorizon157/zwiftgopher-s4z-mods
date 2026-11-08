// The finish outlook (pages/src/engine/finish-outlook.mjs): gaps carried to the line at the
// pace of the last minutes, the states, the predicted places and the verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import {finishOutlook} from '../pages/src/engine/finish-outlook.mjs';

// A field row: clock gap (+ ahead of you), pace (+ you gain on them), seconds of pace history.
const r = (id, clockS, paceSPerMin, paceSpanS = 240) => ({id, name: `Rider ${id}`, clockS, roadS: clockS, paceSPerMin, paceSpanS});

test('no time to go, no outlook', () => {
    assert.equal(finishOutlook([r('a', 5, 1)], {remainingS: null}), null);
});

test('states from the gap at the finish, close shrinking with the time to go', () => {
    // 10 min to go: close is 10 s.
    const o = finishOutlook([
        r('beat', 6, 1),          // 6 - 10 = 4 s behind you at the finish
        r('reach', 15, 1),        // 5 s ahead at the finish
        r('far', 40, 1),          // 30 s: clear
        r('beaten', -4, -1),      // they finish 6 s ahead of you
        r('press', -12, -0.5),    // 7 s behind at the finish
        r('gone', -8, 2),         // you ride away: 28 s
        r('nopace', 3, null, 0),  // no pace: held at 3 s, close, early
    ], {remainingS: 600});
    const st = id => o.riders.get(id).state;
    assert.deepEqual(['beat', 'reach', 'far', 'beaten', 'press', 'gone', 'nopace'].map(st),
        ['beat', 'reach', 'clear', 'beaten', 'pressure', 'clear', 'reach']);
    assert.equal(o.closeS, 10);
    assert.ok(o.riders.get('nopace').early);
    assert.ok(!o.riders.get('reach').early);
    assert.ok(Math.abs(o.riders.get('reach').needSPerMin - 0.5) < 1e-9, '5 s over 10 min');
    // With 2 min to go close is 5 s (the floor).
    assert.equal(finishOutlook([r('x', 7, 0)], {remainingS: 120}).riders.get('x').state, 'clear');
    assert.equal(finishOutlook([r('x', 4, 0)], {remainingS: 120}).riders.get('x').state, 'reach');
    // A short pace history is early.
    assert.ok(finishOutlook([r('x', 4, 1, 120)], {remainingS: 600}).riders.get('x').early);
});

test('states hold past their line so a rider on the edge does not flicker', () => {
    const prev = finishOutlook([r('a', 5, 1.2)], {remainingS: 600});   // -7: beat
    assert.equal(prev.riders.get('a').state, 'beat');
    assert.equal(finishOutlook([r('a', 5, 0.55)], {remainingS: 600, prev}).riders.get('a').state, 'beat', '-0.5 s holds');
    assert.equal(finishOutlook([r('a', 5, 0.55)], {remainingS: 600}).riders.get('a').state, 'reach', 'not beat from fresh');
    const near = finishOutlook([r('b', -10, 0)], {remainingS: 600});
    assert.equal(near.riders.get('b').state, 'pressure');
    assert.equal(finishOutlook([r('b', -12, 0)], {remainingS: 600, prev: near}).riders.get('b').state, 'pressure', 'within 25 %');
    assert.equal(finishOutlook([r('b', -12, 0)], {remainingS: 600}).riders.get('b').state, 'clear');
});

test('predicted places and times', () => {
    const o = finishOutlook([
        r('p2', 20, 0),           // stays ahead
        r('p3', 3, 1),            // you beat: 7 s behind at the finish
        r('p5', -2, -1),          // beats you: 8 s ahead
        r('p6', -30, 0),
    ], {remainingS: 600, homeFinishS: 1800, homePosition: 4});
    assert.equal(o.home.place, 4);
    assert.equal(o.home.predictedPlace, 4, 'one gained, one lost');
    const place = id => o.riders.get(id).place;
    assert.deepEqual(['p2', 'p5', 'p3', 'p6'].map(place), [2, 3, 5, 6]);
    assert.equal(o.riders.get('p5').finishS, 1792);
    assert.equal(o.riders.get('p3').finishS, 1807);
});

test('verdicts', () => {
    const v = (list, opts = {}) => finishOutlook(list, {remainingS: 600, homePosition: 5, ...opts}).verdict;
    assert.equal(v([r('a', 40, 0), r('b', -40, 0)]).kind, 'clear');
    const clear = v([r('a', 40, 0), r('b', -25, 0)]);
    assert.equal(clear.upS, 40);
    assert.equal(clear.backS, 25);
    const defend = v([r('a', -6, -0.2), r('b', -9, -0.1)]);
    assert.equal(defend.kind, 'defend');
    assert.equal(defend.rider.id, 'a', 'the closest threat first');
    assert.equal(defend.others, 1);
    assert.equal(v([r('a', -4, -1)]).rider.state, 'beaten', 'one who beats you comes first');
    assert.equal(v([r('a', 8, 0)]).kind, 'chase');
    const contested = v([r('a', 8, 0), r('b', -3, 0)]);
    assert.equal(contested.kind, 'contested');
    assert.deepEqual([contested.lo, contested.hi], [4, 6]);
    assert.equal(contested.spreadS, 8);
    assert.equal(v([r('a', 8, null, 0)]).kind, 'early', 'no pace from anyone yet');
    assert.equal(v([r('a', 8, 1)], {remainingS: 0}).kind, 'done');
});
