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

test('the line passed in is the one the start uses: a line 150 m in is not backdated by the 10 s cap', () => {
    // The rider crossed the line 0.25 s ago at 8 m/s: 2 m past a line at plan metre 150.
    const plan = withLine(0);
    const at = {kind: 'tt', rule: 'distance', prev: tick(0), plan};
    const crossed = advanceClock(createClock(), {...at, tick: tick(10, {speed: 28.8, worldTime: T0 + 5000}), planM: 152, lineM: 150});
    assert.equal(crossed.signal, 'distance');
    assert.equal(crossed.startPlanM, 150, 'the start is at the line in plan metres');
    assert.equal(crossed.startWorldMs, T0 + 5000 - 250, 'backdated by 2 m at 8 m/s, not by the cap');
    // Without the line passed in the rule's line (0) would have backdated by the full cap.
    const ruled = advanceClock(createClock(), {...at, tick: tick(10, {speed: 28.8, worldTime: T0 + 5000}), planM: 152});
    assert.equal(ruled.startWorldMs, T0 + 5000 - 10000);
});

test('a line passed in decides whether the distance has started: a rider before it has not', () => {
    const plan = withLine(0);
    const before = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(0), tick: tick(4, {speed: 28.8}), plan, planM: 140, lineM: 150});
    assert.equal(before.running, false, 'plan metre 140 is short of a line at 150');
    const after = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(0), tick: tick(4, {speed: 28.8}), plan, planM: 152, lineM: 150});
    assert.equal(after.running, true);
});

test('Zwift\'s own clock starts at the line in plan metres, not the metre the rider is at', () => {
    const plan = withLine(0);
    const clock = advanceClock(createClock(), {kind: 'tt', rule: 'auto', prev: tick(0), tick: tick(400, {time: 5, speed: 28.8, worldTime: T0 + 9000}), plan, planM: 400, lineM: 160});
    assert.equal(clock.signal, 'time');
    assert.equal(clock.startPlanM, 160);
    assert.equal(clock.elapsedS, 5);
});
