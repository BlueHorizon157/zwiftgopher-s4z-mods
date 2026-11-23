// Crit Cross, 2026-11-23 (rebuilt from a TrainerControl log, see the fixture's meta): a plan whose
// timing line the course finds 70 m on after the clock started, and Sauce's event length 84 m
// longer than the race. The prediction must not take the 70 m for the rider's pace, and a course
// whose finish was measured ends the race there, on ZwiftPower's time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const recording = parseJsonl(gunzipSync(readFileSync(new URL('crit-cross-2026-11-23.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(recording);
const info = recording.find(r => r.ch === 'rpc' && r.d.method === 'getEventSubgroup').d.result;
const home = recording.filter(r => r.ch === 'athlete/watching');
const raced = read('crit-cross-2026-11-23.plan.json');
const measured = read('crit-cross-2026-11-23.measured.plan.json');

const ZWIFTPOWER_S = 1448.066;      // the result, from the line
const SAUCE_FINISH_S = 1455.4;      // the mod live, finishing on Sauce's distance to go

function replay(rawPlan, {edit = null} = {}) {
    const engine = createEngine({plan: normalisePlan(rawPlan), prefs: {smoothingSec: 0}});
    const samples = [];
    let told = false;
    for (const row of home) {
        const d = edit ? edit(row.d) : row.d;
        engine.tick(d, meta.startedAt + row.t);
        if (!told) {
            told = true;
            engine.event('eventInfo', {subgroupId: String(info.id), kind: 'tt', startMs: info.eventSubgroupStart, name: info.name}, meta.startedAt + row.t);
        }
        const v = engine.view();
        if (v.status === 'racing' && Number.isFinite(v.race.deltaS)) {
            samples.push({s: v.race.elapsedS, deltaS: v.race.deltaS});
        }
    }
    return {engine, samples, log: engine.view().log.map(l => l.msg)};
}

test('fixture: the plan raced has the line 20.8 m in (overrun rule), the measured one at its metre 0 and a measured finish', () => {
    assert.equal(raced.route.line_source, 'overrun');
    assert.equal(raced.route.lap_overrun_m, 20.8);
    assert.equal(measured.route.line_source, 'measured');
    assert.equal(measured.route.finish_source, 'measured');
    assert.ok(Math.abs(measured.route.finish_m - 15266.6) < 1);
    assert.equal(home[0].d.remainingEnd, 15349, 'Sauce\'s event length');
});

test('the course finds the line 70 m on: the intervals begun before move with it, and the prediction is not 30 s ahead', () => {
    const {engine, samples, log} = replay(raced);
    assert.ok(log.some(m => /^Course matched: the timing line is 7\d m into the plan$/.test(m)), log.join(' | '));
    const first = engine.state.tracking.stats[0];
    assert.ok(first.startPlanM > 75 && first.startPlanM < 90, `interval 1 began at plan metre ${first.startPlanM.toFixed(1)} (the line + 1 s)`);
    const finalS = engine.view().race.deltaS;
    assert.ok(finalS > 7 && finalS < 12, `delta at the finish ${finalS.toFixed(1)}`);
    // Live (0.9.7): -33 s at 1:00, -21 at 3:00, about level at 6:00, for a race finished 9 s behind.
    const at = s => samples.find(x => x.s >= s);
    assert.ok(Math.abs(at(60).deltaS - finalS) < 10, `at 1:00: ${at(60).deltaS.toFixed(1)} against ${finalS.toFixed(1)}`);
    const early = samples.filter(x => x.s >= 30 && x.s <= 300);
    const meanErr = early.reduce((sum, x) => sum + Math.abs(x.deltaS - finalS), 0) / early.length;
    assert.ok(meanErr < 10, `first five minutes: mean error ${meanErr.toFixed(1)} s`);
});

test('without a measured finish the race ends where Sauce\'s distance to go runs out (its length 84 m long here)', () => {
    const {engine, log} = replay(raced);
    assert.equal(engine.view().status, 'finished');
    assert.ok(Math.abs(engine.state.finishS - SAUCE_FINISH_S) < 1, `finish ${engine.state.finishS}`);
    assert.ok(!log.some(m => /the course's finish/.test(m)));
});

test('a measured finish: the race ends at the course\'s finish, on ZwiftPower\'s time', () => {
    const {engine, log} = replay(measured);
    assert.equal(engine.view().status, 'finished');
    assert.ok(Math.abs(engine.state.finishS - ZWIFTPOWER_S) < 0.3, `finish ${engine.state.finishS.toFixed(2)} against ZwiftPower's ${ZWIFTPOWER_S}`);
    assert.ok(log.some(m => /^Finished: 1448\.\d s on the clock \(the course's finish\)$/.test(m)), log.at(-1));
    assert.ok(Math.abs(engine.view().race.finishM - measured.route.finish_m) < 0.5, 'the finish the view shows is the course\'s');
});

test('a course measured for its line only (no finish_source) keeps Sauce\'s finish', () => {
    const lineOnly = structuredClone(measured);
    delete lineOnly.route.finish_source;
    const {engine, log} = replay(lineOnly);
    assert.ok(Math.abs(engine.state.finishS - SAUCE_FINISH_S) < 1, `finish ${engine.state.finishS}`);
    assert.ok(!log.some(m => /the course's finish/.test(m)));
});

test('Sauce\'s length far from the course\'s finish (another race than the plan\'s): the course\'s finish is not trusted', () => {
    const twoLaps = d => ({...d, remainingEnd: 30000, remaining: 30000 - (d.state?.eventDistance ?? 0)});
    const {engine} = replay(measured, {edit: twoLaps});
    assert.equal(engine.view().status, 'racing', 'still racing: the event goes on past the plan');
    assert.equal(engine.state.finishS, null);
});
