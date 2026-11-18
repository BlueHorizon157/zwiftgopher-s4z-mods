// Joining a TT from a warm-up, through the engine: the rider's CTT Winter Series TT on The Fan
// Flats (2026-11-18, Richmond, route 1638640398, 3 laps; ZwiftPower event 5777341, C), recorded
// with mod 0.9.6 and anonymised, with the plan raced (S9L9E3, anonymised).
//
// What the race taught: the plan was loaded on a Watopia warm-up. Sauce gave the event's subgroup
// at 19:01:33 while the ticks still carried the warm-up (course 6, event distance 12786 m, timer
// 1564 s) for three seconds; then the pen (course 2, timer, event distance and ride distance all
// 0), 17 s before the next tick while Zwift loaded Richmond. 0.9.6 took the first of those ticks
// for a race 12.8 km along and started the clock; the pen did not arm it again, so the clock ran
// in the pen (the prediction drifting to 'behind' at a second a second) until the rider reset it
// 60 m past the line, after the first interval's start. Now nothing is placed or started between
// the subgroup and the pen; a rider back at the start while racing is armed again; and a cleared
// clock in an event starts on Zwift's timer as it stands.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine, PEN_HOLD_MS} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const recording = parseJsonl(gunzipSync(readFileSync(new URL('fan-flats-2026-11-18.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(recording);
const plan = normalisePlan(JSON.parse(readFileSync(new URL('fan-flats-2026-11-18.plan.json', dir), 'utf8')));

const RICHMOND = 2;
const isHome = r => r.ch === 'athlete/watching';
const home = recording.filter(isHome);
const firstStale = home.findIndex(r => r.d.state.eventSubgroupId);
const firstPen = home.findIndex(r => r.d.state.eventSubgroupId && r.d.state.courseId === RICHMOND);
const firstPast = home.findIndex(r => r.d.state.courseId === RICHMOND && r.d.state.eventDistance > 0);
const finishTick = home.find(r => r.d.state.courseId === RICHMOND && r.d.remaining <= 0);

/**
 * Every row through an engine: the event info when Sauce's RPC answered, the rider's ticks as they
 * came. from: the first home tick to feed (a window opened then). edit(row) may replace a tick;
 * at(engine, row, i) runs after each home tick (a reset by the rider).
 */
function replay({from = 0, at = null, edit = null} = {}) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    const startT = home[from].t;
    const ticks = [];
    let told = false;
    for (const row of recording) {
        if (row.ch === 'rpc' && row.d.method === 'getEventSubgroup' && !told && row.t <= startT + 1000) {
            told = true;
            engine.event('eventInfo', {subgroupId: String(row.d.result.id), kind: 'tt', startMs: row.d.result.eventSubgroupStart, name: row.d.result.name}, meta.startedAt + row.t);
            continue;
        }
        if (!isHome(row) || row.t < startT) {
            continue;
        }
        const d = edit ? edit(row) : row.d;
        engine.tick(d, meta.startedAt + row.t);
        at?.(engine, row, ticks.length);
        const v = engine.view();
        ticks.push({row, d, status: v.status, planM: v.race.planM, elapsedS: v.race.elapsedS, signal: v.race.signal, deltaS: v.race.deltaS, number: v.target?.number ?? null});
    }
    return {engine, ticks, view: engine.view(), log: engine.view().log.map(l => l.msg)};
}

test('fixture: the subgroup arrives on the warm-up, then the pen, then the line', () => {
    assert.ok(firstStale > 0 && firstPen > firstStale && firstPast > firstPen && finishTick);
    const stale = home[firstStale].d.state;
    assert.equal(stale.courseId, 6);
    assert.ok(stale.eventDistance > 12000 && stale.time > 1500, 'the first tick in the event is still the warm-up');
    const pen = home[firstPen].d.state;
    assert.deepEqual([pen.time, pen.eventDistance, pen.distance], [0, 0, 0]);
});

test('joining from a warm-up: armed through the warm-up ticks and the pen, racing from the timing line', () => {
    const {ticks, view, log} = replay();
    const homeTicks = ticks.filter(x => x.row.t >= home[firstStale].t);
    const before = homeTicks.filter(x => x.row.t < home[firstPast].t);
    assert.ok(before.length > 100);
    assert.ok(before.every(x => x.status === 'armed'), 'nothing races before the line');
    assert.ok(before.every(x => x.elapsedS == null && x.deltaS == null), 'no clock or prediction in the pen');
    // The warm-up ticks in the event place nobody: the HUD shows the first interval, not the 11th.
    const stale = ticks.filter(x => x.d.state.eventSubgroupId && x.d.state.courseId !== RICHMOND);
    assert.ok(stale.length >= 3);
    assert.ok(stale.every(x => x.planM == null && x.number === 1));
    // The clock starts on the tick that leaves the line.
    const started = ticks.find(x => x.status === 'racing');
    assert.equal(started.row, home[firstPast]);
    assert.ok(started.elapsedS < 1);
    // Every interval, and the finish on Zwift's timer.
    assert.equal(view.status, 'finished');
    assert.equal(view.race.completed, plan.intervals.length);
    assert.ok(Math.abs(view.race.elapsedS - finishTick.d.state.time) < 1.5, `finish ${view.race.elapsedS} vs Zwift's ${finishTick.d.state.time}`);
    assert.ok(log.some(m => m.startsWith('Joined event')) && log.includes('In the pen: the clock starts at the timing line'));
    assert.ok(!log.some(m => m.includes('back at the start')));
});

test('the targets switch at the plan\'s boundaries once racing from the line', () => {
    const {ticks} = replay();
    // The tick each interval took over, against the event metre of its boundary on the matched
    // course (the line is a few metres from the plan's start: within 25 m, about 2.5 s).
    let prev = null;
    for (const x of ticks) {
        if (x.status !== 'racing' || x.number == null) {
            continue;
        }
        if (prev != null && x.number !== prev) {
            const iv = plan.intervals[x.number - 1];
            assert.ok(Math.abs(x.planM - iv.startM) < 25, `interval ${x.number} began at plan metre ${x.planM.toFixed(0)} vs ${iv.startM}`);
        }
        prev = x.number;
    }
    assert.equal(prev, plan.intervals.length);
});

test('the finish prediction is not thrown by a first interval ridden on time on less power', () => {
    // The rider crossed the line at 34.6 km/h and rode the first interval (272 W planned, the
    // power to get up to speed) at 241 W in 44.2 s against 45.3: on time. The power ratio alone
    // made that 36 s behind at 45 s and still 26 s behind at two minutes; the finish was 4.4 s
    // ahead. Now the speed against the plan answers the power (tracking.mjs, 2026-11-18).
    const {ticks, view} = replay();
    const truth = view.race.elapsedS - view.race.planTimeFromStartS;
    assert.ok(truth < 0 && truth > -10, `finish against the plan ${truth.toFixed(1)}`);
    const racing = ticks.filter(x => x.status === 'racing' && x.deltaS != null);
    const off = fromS => Math.max(...racing.filter(x => x.elapsedS >= fromS).map(x => Math.abs(x.deltaS - truth)));
    assert.ok(off(30) < 20, `worst after 30 s: ${off(30).toFixed(1)} s`);
    assert.ok(off(120) < 12, `worst after two minutes: ${off(120).toFixed(1)} s`);
    // Nothing is said before START_SKIP_S of racing has a sample (the HUD shows no words then).
    const endOfFirst = racing.find(x => x.number === 2);
    assert.ok(endOfFirst.deltaS < 10, `at the end of the first interval: ${endOfFirst.deltaS.toFixed(1)} s`);
});

test('a window opened on a warm-up tick in the event: the pen arms the race again', () => {
    const {ticks, view, log} = replay({from: firstStale});
    // That first tick looks like a race 26 minutes in (nothing before it says otherwise).
    assert.equal(ticks[0].status, 'racing');
    // In the pen for PEN_HOLD_MS: armed again, and from the line as if nothing had happened.
    const rearmed = ticks.findIndex(x => x.status === 'armed');
    assert.ok(rearmed > 0);
    const at = ticks[rearmed].d.state;
    assert.equal(at.courseId, RICHMOND);
    assert.ok(ticks[rearmed].d.state.worldTime - home[firstPen].d.state.worldTime >= PEN_HOLD_MS);
    assert.ok(log.includes('Statistics cleared: back at the start of the event (in the pen)'));
    const started = ticks.findIndex((x, i) => i > rearmed && x.status === 'racing');
    assert.equal(ticks[started].row, home[firstPast]);
    assert.equal(view.status, 'finished');
    assert.ok(Math.abs(view.race.elapsedS - finishTick.d.state.time) < 1.5);
});

test('one stray tick at zero mid-race does not arm the race again', () => {
    const mid = home.findIndex(r => r.d.state.courseId === RICHMOND && r.d.state.time >= 600);
    const glitch = home[mid];
    const {view, log} = replay({edit: row => (row === glitch ? {...row.d, state: {...row.d.state, time: 0, eventDistance: 0}} : row.d)});
    assert.ok(!log.some(m => m.includes('back at the start')));
    assert.equal(view.status, 'finished');
    assert.equal(view.race.completed, plan.intervals.length);
});

test('a reset mid-race starts again on Zwift\'s race timer, not a guess from the metres', () => {
    const resetRow = home.find(r => r.d.state.courseId === RICHMOND && r.d.state.time >= 42);
    const {ticks, view, log} = replay({at: (engine, row) => {
        if (row === resetRow) {
            engine.event('reset', {}, meta.startedAt + row.t);
        }
    }});
    assert.ok(log.includes('Statistics cleared: reset by the rider'));
    const after = ticks.filter(x => x.row.t > resetRow.t && x.status === 'racing');
    assert.equal(after[0].signal, 'time');
    assert.equal(after[0].elapsedS, after[0].d.state.time);
    assert.equal(view.status, 'finished');
    assert.ok(Math.abs(view.race.elapsedS - finishTick.d.state.time) < 1.5);
});
