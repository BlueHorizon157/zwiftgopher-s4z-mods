// The engine on the synthetic recordings (docs/REVAMP_PLAN.md 1.7/1.8): states, the
// clock, the first interval, the prediction and the W' at the finish.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const plan = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
const rows = parseJsonl(readFileSync(new URL('./fixtures/telemetry/synthetic-flat-tt.jsonl', import.meta.url), 'utf8'));
const ticks = rows.filter(r => r.ch === 'athlete/watching');
const epoch = metaOf(rows).startedAt;

function run({prefs = {}, until = Infinity, onTick = null} = {}) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0, ...prefs}});
    const seen = [];
    for (const row of ticks) {
        if (row.t > until) {
            break;
        }
        engine.tick(row.d, epoch + row.t);
        const v = engine.view();
        seen.push(v.status);
        onTick?.(row, v, engine);
    }
    return {engine, statuses: [...new Set(seen)]};
}

test('states: armed in the pen, racing from the line, finished at the end', () => {
    const {engine, statuses} = run();
    assert.deepEqual(statuses, ['armed', 'racing', 'finished']);
    const v = engine.view();
    assert.equal(v.race.signal, 'time', 'the synthetic start line is state.time leaving 0');
    assert.ok(v.race.elapsedS > 800 && v.race.elapsedS < 900, `race ${v.race.elapsedS}`);
    assert.equal(v.race.completed, plan.intervals.length, 'every interval completed');
});

test('the first interval opens on the start tick and is not partial', () => {
    let startView = null;
    run({onTick: (row, v) => { if (!startView && v.status === 'racing') { startView = v; } }});
    assert.ok(startView, 'racing reached');
    const first = startView.stats[0];
    assert.ok(first, 'interval 1 has statistics from the first racing tick');
    assert.equal(first.partial, false);
    assert.equal(startView.target.number, 1);
    assert.ok(startView.race.planM >= 150 && startView.race.planM < 260, `clock started at plan metre ${startView.race.planM}`);
});

test('riding the plan exactly predicts the plan: delta within 2 s, pacing 1', () => {
    let lastRacing = null;
    const {engine} = run({onTick: (row, v) => { if (v.status === 'racing') { lastRacing = v; } }});
    const v = engine.view();
    assert.ok(Math.abs(v.race.deltaS) <= 2, `delta at the finish ${v.race.deltaS}`);
    assert.ok(Math.abs(lastRacing.race.pacing - 1) < 0.02, `pacing ${lastRacing.race.pacing}`);
    assert.ok(Math.abs(v.race.totalS - v.race.planTimeFromStartS) <= 2);
});

test('the W\' at the finish matches the plan\'s last wbal_kj', () => {
    const {engine} = run();
    const v = engine.view();
    const planEnd = plan.intervals.at(-1).wbal_kj;
    assert.ok(Math.abs(v.wbal.kj - planEnd) < 0.5, `engine ${v.wbal.kj.toFixed(2)} kJ vs plan ${planEnd} kJ`);
});

test('each interval closes with the W\' the plan has for its end', () => {
    const {engine} = run();
    const v = engine.view();
    plan.intervals.forEach((iv, i) => {
        const s = v.stats[i];
        assert.ok(s?.finished, `interval ${i + 1} finished`);
        assert.ok(Number.isFinite(s.wbalEndJ), `interval ${i + 1} has a closing W'`);
        assert.ok(Math.abs(s.wbalEndJ / 1000 - iv.wbal_kj) < 0.6, `interval ${i + 1}: ${(s.wbalEndJ / 1000).toFixed(2)} vs plan ${iv.wbal_kj}`);
    });
});

test('targets follow the plan with bias and the look-ahead switches early', () => {
    const normalised = normalisePlan(plan);
    const second = normalised.intervals[1];
    let switched = null;
    let onTarget = 0;
    run({
        prefs: {lookAheadSec: 5, bandWidthW: 5},
        onTick: (row, v, engine) => {
            if (v.status !== 'racing') {
                return;
            }
            if (v.target.band === 'on') {
                onTarget++;
            }
            if (switched == null && v.target.number === 2) {
                switched = v.race.planM;
            }
            if (row.t === 300_000) {
                engine.control('bias', 1.05);
            }
            if (row.t === 301_000) {
                assert.ok(Math.abs(v.target.powerW - v.target.planPowerW * 1.05) < 1e-9, 'bias applied');
                engine.control('bias', 1);
            }
        },
    });
    assert.ok(switched < second.startM && switched > second.startM - 80, `target switched at ${switched} m for a boundary at ${second.startM} m`);
    assert.ok(onTarget > 700, `on target for ${onTarget} ticks`);
});

test('a plan change and a reset clear the race; another rider is spectated', () => {
    const {engine} = run({until: 200_000});
    assert.equal(engine.view().status, 'racing');
    engine.event('reset');
    assert.equal(engine.view().status, 'armed');
    assert.equal(engine.view().race.running, false);
    engine.tick({...ticks[300].d, athleteId: 999, self: false}, epoch + 300_000);
    assert.equal(engine.view().spectating?.athleteId, '999');
    engine.tick(ticks[300].d, epoch + 300_000);
    assert.equal(engine.view().spectating, null);
    engine.event('plan', {plan: null});
    assert.equal(engine.view().status, 'idle');
});

test('a late join starts the clock from state.time and marks the interval partial', () => {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    const late = ticks.filter(r => r.t >= 400_000);
    for (const row of late) {
        engine.tick(row.d, epoch + row.t);
    }
    const v = engine.view();
    assert.equal(v.status, 'finished');
    const first = v.stats.find(s => s);
    assert.equal(first.partial, true, 'the interval joined mid-way is partial');
    assert.ok(v.race.elapsedS > 800, 'the clock is the race time, not time since joining');
});
