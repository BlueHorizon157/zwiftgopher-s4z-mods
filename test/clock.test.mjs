// The TT timing line (docs/REVAMP_PLAN.md 1.2, planner 2026-10-27): plan files that say where
// the clock starts (route.start_line_m, 0 = the pen on most routes) against older files on
// the 150 m start-delay rule, and the distance fallback that must not start a rider still in
// the pen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {
    createClock, advanceClock, lineMetre, gunToLineS, worldToUnixMs, unixToWorldMs, ZWIFT_EPOCH_MS, MAX_GUN_TO_LINE_S,
} from '../pages/src/engine/clock.mjs';

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

// A mass start (race 5780317, 2026-11-11): the gun at 18:40:00 UTC, the game's distance and timer
// at 0 for the 102 m to the timing line, crossed 18.8 s later. Zwift's world time is its own scale.
const GUN_UNIX_MS = 1_794_422_400_000;
const GUN_WORLD_MS = GUN_UNIX_MS - ZWIFT_EPOCH_MS;

test('a mass start: the clock starts at the timing line as a TT\'s does, not at the gun', () => {
    const plan = withLine(0);
    const at = (ed, s, more = {}) => tick(ed, {worldTime: GUN_WORLD_MS + s * 1000, ...more});
    let clock = createClock();
    // The gun has gone and the rider is riding out of the pen: the game's distance is still 0.
    clock = advanceClock(clock, {kind: 'group', rule: 'auto', prev: null, tick: at(0, 1, {speed: 20}), plan, planM: 0});
    assert.equal(clock.running, false, 'the gun does not start it');
    clock = advanceClock(clock, {kind: 'group', rule: 'auto', prev: at(0, 1), tick: at(0, 18, {speed: 38}), plan, planM: 0});
    assert.equal(clock.running, false);
    // Over the line: 5 m past it at 36 km/h, so it was crossed half a second ago.
    clock = advanceClock(clock, {kind: 'group', rule: 'auto', prev: at(0, 18), tick: at(5, 19.3, {speed: 36}), plan, planM: 5});
    assert.equal(clock.running, true);
    assert.equal(clock.justStarted, true);
    assert.equal(clock.signal, 'distance');
    assert.equal(clock.lineWorldMs, GUN_WORLD_MS + 18_800);
    assert.equal(gunToLineS(clock, GUN_UNIX_MS), 18.8);
    // The game's own timer starts it the same way.
    const timed = advanceClock(createClock(), {kind: 'group', rule: 'auto', prev: at(0, 18), tick: at(15, 20.3, {time: 1, speed: 36}), plan, planM: 15});
    assert.equal(timed.signal, 'time');
    assert.equal(timed.lineWorldMs, GUN_WORLD_MS + 18_800);
});

test('Zwift\'s world time and Unix time: each is put on the other\'s scale, and a value already there is kept', () => {
    assert.equal(worldToUnixMs(GUN_WORLD_MS), GUN_UNIX_MS);
    assert.equal(worldToUnixMs(GUN_UNIX_MS), GUN_UNIX_MS, 'a synthetic recording keeps Unix time in worldTime');
    assert.equal(unixToWorldMs(GUN_UNIX_MS, GUN_WORLD_MS + 5000), GUN_WORLD_MS);
    assert.equal(unixToWorldMs(GUN_UNIX_MS, GUN_UNIX_MS + 5000), GUN_UNIX_MS);
    assert.equal(unixToWorldMs(GUN_WORLD_MS, GUN_WORLD_MS + 5000), GUN_WORLD_MS);
    for (const bad of [null, undefined, NaN, 'x']) {
        assert.equal(worldToUnixMs(bad), null);
        assert.equal(unixToWorldMs(bad, GUN_WORLD_MS), null);
        assert.equal(unixToWorldMs(GUN_UNIX_MS, bad), null);
    }
});

test('the seconds from the gun to the line: only for a running clock, a known gun and a plausible start', () => {
    const running = {...createClock(), running: true, startWorldMs: GUN_WORLD_MS + 19_000, lineWorldMs: GUN_WORLD_MS + 18_800};
    assert.equal(gunToLineS(running, GUN_UNIX_MS), 18.8);
    assert.equal(gunToLineS({...running, lineWorldMs: null}, GUN_UNIX_MS), null, 'no crossing known: the clock\'s own start is not taken for it');
    assert.equal(gunToLineS(running, null), null, 'no start time from Sauce');
    assert.equal(gunToLineS({...running, running: false}, GUN_UNIX_MS), null);
    assert.equal(gunToLineS(createClock(), GUN_UNIX_MS), null);
    assert.equal(gunToLineS(running, GUN_UNIX_MS + 60_000), null, 'a line before the gun is not a start');
    assert.equal(gunToLineS(running, GUN_UNIX_MS - (MAX_GUN_TO_LINE_S + 1) * 1000), null, 'a late join is not a start');
    // A synthetic recording: both on the Unix scale.
    assert.equal(gunToLineS({...running, startWorldMs: T0 + 12_000, lineWorldMs: T0 + 12_000}, T0), 12);
});

test('a TT, a free ride and a plan from here are as they were: the line starts a TT, the arm the others', () => {
    const plan = withLine(0);
    const tt = advanceClock(createClock(), {kind: 'tt', rule: 'auto', prev: tick(0), tick: tick(8, {speed: 28.8, worldTime: T0 + 2000}), plan, planM: 8});
    assert.equal(tt.signal, 'distance');
    assert.equal(tt.startWorldMs, T0 + 1000);
    assert.equal(tt.lineWorldMs, T0 + 1000);
    const manual = advanceClock(createClock(), {kind: 'manual', prev: null, tick: tick(0, {worldTime: T0 + 5000}), plan, planM: 0, armedWorldMs: T0 + 3000});
    assert.equal(manual.signal, 'manual');
    assert.equal(manual.startWorldMs, T0 + 3000);
    assert.equal(manual.lineWorldMs, null);
    const here = advanceClock(createClock(), {kind: 'here', prev: null, tick: tick(4000, {worldTime: T0 + 5000, speed: 36}), plan, planM: 0, armedWorldMs: T0 + 4000});
    assert.equal(here.signal, 'here');
    assert.equal(here.lineWorldMs, null);
});

test('a window opened mid-race: Zwift\'s timer says when the line was crossed, the metres ridden do not', () => {
    const plan = withLine(0);
    // 250 s into the race (the line was crossed 18.8 s after the gun), 2.6 km on at 36 km/h.
    const now = GUN_WORLD_MS + 18_800 + 250_400;
    const joined = advanceClock(createClock(), {kind: 'group', rule: 'auto', prev: null, tick: tick(2600, {time: 250, speed: 36, worldTime: now}), plan, planM: 2600});
    assert.equal(joined.signal, 'time');
    assert.equal(joined.elapsedS, 250);
    assert.equal(joined.lineWorldMs, now - 250_500, 'from the timer (whole seconds done: half a second more), not ten seconds ago');
    const gunS = gunToLineS(joined, GUN_UNIX_MS);
    assert.ok(Math.abs(gunS - 18.8) <= 0.5, `gun to line ${gunS}`);
    // No timer either: the clock starts late (as it always did), and that is no start to add a gun to.
    const blind = advanceClock(createClock(), {kind: 'group', rule: 'distance', prev: null, tick: tick(2600, {speed: 36, worldTime: now}), plan, planM: 2600});
    assert.equal(blind.signal, 'distance');
    assert.equal(blind.lineWorldMs, null);
    assert.equal(gunToLineS(blind, GUN_UNIX_MS), null);
    // A crossing seen that the timer contradicts (a stale distance) gives way to the timer.
    const odd = advanceClock(createClock(), {kind: 'group', rule: 'auto', prev: null, tick: tick(20, {time: 60, speed: 36, worldTime: now}), plan, planM: 20});
    assert.equal(odd.lineWorldMs, now - 60_500);
});
