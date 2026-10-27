// Placing the rider in the plan (docs/REVAMP_PLAN.md 6.2): the timing line's plan metre
// from the event's length, the file's start_line_m as the fallback, and what counts as a
// plan for another distance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planMetre, lineOffsetM, lineInPlanM, mismatchM, LINE_MAX_M} from '../pages/src/engine/align.mjs';

const plan = {lengthM: 10710, startLineM: 0};
const tick = (eventDistance, remainingEnd) => ({state: {eventDistance, eventSubgroupId: 1}, remainingMetric: 'distance', remainingEnd});

test('the line is the plan length minus the event length', () => {
    assert.equal(lineOffsetM(tick(0, 10610), plan), 100);
    assert.equal(lineInPlanM(tick(0, 10610), plan), 100);
    assert.equal(planMetre(tick(0, 10610), {plan}), 100);
    assert.equal(planMetre(tick(500, 10610), {plan, offsetM: 10}), 610);
    assert.equal(mismatchM(tick(0, 10610), plan), null);
});

test('without an event length the file places the line; 0 without a line', () => {
    const noLength = d => ({state: {eventDistance: d, eventSubgroupId: 1}});
    assert.equal(planMetre(noLength(40), {plan: {...plan, startLineM: 30}}), 70);
    assert.equal(planMetre(noLength(40), {plan: {lengthM: 10710, startLineM: null}}), 40);
    assert.equal(planMetre(noLength(40), {}), 40);
});

test('a plan for another distance is a mismatch and the file\'s line is the fallback', () => {
    const lap = {lengthM: 22422, startLineM: 0};            // one lap planned, 16.15 km raced
    assert.equal(mismatchM(tick(0, 16150), lap), 16150 - 22422);
    assert.equal(lineOffsetM(tick(0, 16150), lap), null);
    assert.equal(planMetre(tick(100, 16150), {plan: lap}), 100);
    assert.equal(mismatchM(tick(0, 10900), plan), 190);     // the event longer by 1.8 %
    assert.equal(mismatchM(tick(0, 10710 - LINE_MAX_M), plan), null);
    assert.equal(mismatchM(tick(0, 10710 - LINE_MAX_M - 1), plan), -(LINE_MAX_M + 1));
});
