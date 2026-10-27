// The TT timing line (docs/REVAMP_PLAN.md 1.2, planner 2026-10-27): plan files that say where
// the clock starts (route.start_line_m, 0 = the pen on most routes) against older files on
// the 150 m start-delay rule, and the distance fallback that must not start a rider still in
// the pen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {createClock, advanceClock, lineMetre} from '../pages/src/engine/clock.mjs';

const file = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
const withLine = m => normalisePlan({...file, route: {...file.route, start_line_m: m}});
// The same plan as a file from before the planner wrote start_line_m.
const {start_line_m: _line, ...oldRoute} = file.route;
const oldFile = {...file, route: oldRoute};
const T0 = 1_800_000_000_000;
const tick = (eventDistance, {time = 0, speed = 0, worldTime = T0} = {}) => ({state: {eventDistance, time, speed, worldTime}});

test('the line is the plan length minus the event length; else the file\'s start_line_m; else 0', () => {
    assert.equal(lineMetre(withLine(0)), 0);
    assert.equal(lineMetre(withLine(30)), 30);
    const old = normalisePlan(oldFile);
    assert.equal(old.startLineM, null);
    assert.equal(lineMetre(old), 0);
    assert.equal(lineMetre({}), 0);
    // The event says: 90 m shorter than the plan, so the line is 90 m in, whatever the file says.
    const event = {remainingMetric: 'distance', remainingEnd: old.lengthM - 90};
    assert.equal(lineMetre(withLine(0), event), 90);
    assert.equal(lineMetre(old, event), 90);
});

test('a line at the pen: waiting in the pen does not start the clock, moving does', () => {
    const plan = withLine(0);
    let clock = createClock();
    // In the pen, with a +10 m offset so plan metre 10: Zwift's distance is still 0.
    clock = advanceClock(clock, {kind: 'tt', rule: 'auto', prev: null, tick: tick(0), plan, planM: 10});
    assert.equal(clock.running, false);
    clock = advanceClock(clock, {kind: 'tt', rule: 'auto', prev: tick(0), tick: tick(0, {worldTime: T0 + 1000}), plan, planM: 0});
    assert.equal(clock.running, false);
    // Released: 8 m at 8 m/s, so the line was crossed a second ago.
    clock = advanceClock(clock, {kind: 'tt', rule: 'auto', prev: tick(0), tick: tick(8, {speed: 28.8, worldTime: T0 + 2000}), plan, planM: 8});
    assert.equal(clock.running, true);
    assert.equal(clock.signal, 'distance');
    assert.equal(clock.startPlanM, 0);
    assert.equal(clock.startWorldMs, T0 + 1000);
});

test('Zwift\'s own clock wins over the distance when it runs', () => {
    const clock = advanceClock(createClock(), {kind: 'tt', rule: 'auto', prev: tick(0), tick: tick(40, {time: 5, speed: 28.8, worldTime: T0 + 9000}), plan: withLine(0), planM: 40});
    assert.equal(clock.signal, 'time');
    assert.equal(clock.startWorldMs, T0 + 4000);
    assert.equal(clock.elapsedS, 5);
});

test('a file without start_line_m: the distance fallback starts at the first event metre', () => {
    const plan = normalisePlan(oldFile);
    const before = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(0), tick: tick(0, {speed: 36}), plan, planM: 0});
    assert.equal(before.running, false);
    const after = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(0), tick: tick(5, {speed: 36, worldTime: T0}), plan, planM: 5});
    assert.equal(after.running, true);
    assert.equal(after.startPlanM, 0);
    assert.equal(after.startWorldMs, T0 - 500);
});
