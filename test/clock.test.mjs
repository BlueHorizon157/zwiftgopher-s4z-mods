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
const T0 = 1_800_000_000_000;
const tick = (eventDistance, {time = 0, speed = 0, worldTime = T0} = {}) => ({state: {eventDistance, time, speed, worldTime}});

test('the line is the file\'s start_line_m, else the pen-to-route metres + 150', () => {
    assert.equal(lineMetre(withLine(0)), 0);
    assert.equal(lineMetre(withLine(30)), 30);
    const old = normalisePlan(file);
    assert.equal(old.startLineM, null);
    assert.equal(lineMetre(old), file.route.start_offset_m + 150);
    assert.equal(lineMetre({}), 180);
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

test('an older file keeps the 150 m rule for the distance fallback', () => {
    const plan = normalisePlan(file);
    const line = lineMetre(plan);
    const before = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(100), tick: tick(line - 20, {speed: 36}), plan, planM: line - 20});
    assert.equal(before.running, false);
    const after = advanceClock(createClock(), {kind: 'tt', rule: 'distance', prev: tick(line - 20), tick: tick(line + 5, {speed: 36, worldTime: T0}), plan, planM: line + 5});
    assert.equal(after.running, true);
    assert.equal(after.startPlanM, line);
    assert.equal(after.startWorldMs, T0 - 500);
});
