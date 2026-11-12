// A mass-start race through the engine: Dave's race on the Watopia Hilly Route (2026-11-11,
// route 2737483381, 6.1 km custom distance, no draft; ZwiftPower event 5780317), recorded with
// mod 0.9.2 and anonymised. Two plans:
//
//   padded   the plan raced (share code KM96SD), made before the planner's 2026-11-12 fix: 393 m
//            of padding drawn before the start where the route data's lap does not close, and
//            the timing line 36 m into the data. Its metre is the road's metre plus 429.
//   planner  the same rider and settings from the fixed planner: metre 0 is the timing line.
//
// What the race taught (docs/prediction-pipeline.md):
//   - 0.9.2 refused the padded plan's line (429 m, over its 300 m window), placed the rider by
//     distance alone and switched every target 425 m late, 31 to 123 s. The road now places it.
//   - A mass start has a timing line too: the game's distance and timer sat at zero for 102 m
//     out of the pen, 18.8 s after the gun on Zwift's clock. The plan starts at the line; the
//     result (704.888 s) counts from the gun: 18.8 s plus the 686 s from the line.
//
// The truth is independent of the engine: on the padded plan's course the rider is at
// 0.99856 x eventDistance + 429.1 (measured by projecting every position on the course); the
// planner's plan has the same road 429.1 - 392.9 - 36.2 = 0 m on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {createField, ingest, rows, finishRaceOf} from '../pages/src/engine/field-model.mjs';
import {finishFigure} from '../pages/src/views/dom.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const recording = parseJsonl(gunzipSync(readFileSync(new URL('hilly-race-2026-11-11.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(recording);
const home = recording.filter(r => r.ch === 'athlete/watching');
const plans = {
    padded: normalisePlan(JSON.parse(readFileSync(new URL('hilly-race-2026-11-11.padded.plan.json', dir), 'utf8'))),
    planner: normalisePlan(JSON.parse(readFileSync(new URL('hilly-race-2026-11-11.planner.plan.json', dir), 'utf8'))),
};

const K = 0.99856;
const PADDED_LINE_M = 429.1;        // the padded plan's metre of the timing line (measured)
const OFFICIAL_S = 704.888;         // ZwiftPower, from the gun
const GUN_T_S = (meta.eventStartMs - meta.startedAt) / 1000;
const SUBGROUP = home[0].d.state.eventSubgroupId;
const SWITCH_LIMIT_S = 1.5;

/** Every home tick through the engine; the event's kind and start arrive as Sauce's event RPC gives them. */
function replay(plan, {kind = 'group', startMs = meta.eventStartMs} = {}) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    let told = false;
    const ticks = home.map(row => {
        engine.tick(row.d, meta.startedAt + row.t);
        if (!told && kind) {
            engine.event('eventInfo', {subgroupId: String(SUBGROUP), kind, startMs, name: 'Mass-start race'}, meta.startedAt + row.t);
            told = true;
        }
        const v = engine.view();
        return {
            t: row.t / 1000, ed: row.d.state.eventDistance, time: row.d.state.time,
            status: v.status, planM: v.race.planM, signal: v.race.signal, elapsedS: v.race.elapsedS,
            gunToLineS: v.race.gunToLineS, officialElapsedS: v.race.officialElapsedS, officialTotalS: v.race.officialTotalS, totalS: v.race.totalS,
            index: v.target ? v.target.index : null, alignment: v.race.alignment,
        };
    });
    return {ticks, view: engine.view(), log: engine.view().log.map(l => l.msg)};
}

/** Recording seconds at which the rider's event distance reaches edStar. */
function crossingT(edStar) {
    let prev = null;
    for (const row of home) {
        const ed = row.d.state.eventDistance;
        if (!(ed > 0)) continue;
        if (ed >= edStar) {
            return prev ? (prev.t + (edStar - prev.ed) / (ed - prev.ed) * (row.t - prev.t)) / 1000 : row.t / 1000;
        }
        prev = {t: row.t, ed};
    }
    return null;
}

/** Each interval's switch against the rider reaching its metre on the road (truth: plan metre = K x ed + lineM). */
function switchErrors(run, plan, lineM) {
    const errors = [];
    for (let i = 1; i < plan.intervals.length; i++) {
        const sw = run.ticks.find(k => k.index === i && (k.status === 'racing' || k.status === 'finished'));
        const reached = crossingT((plan.intervals[i].startM - lineM) / K);
        errors.push({number: i + 1, startM: plan.intervals[i].startM, switched: sw?.t ?? null, reached, lateS: sw && reached != null ? sw.t - reached : null});
    }
    return errors;
}

test('the recording: a gun, then 19 s and 102 m with the game\'s distance and timer at zero', () => {
    const moving = home.find(r => r.d.state.speed > 1);
    const line = home.find(r => r.d.state.eventDistance > 0);
    const timer = home.find(r => r.d.state.time > 0);
    assert.ok(Math.abs(moving.t / 1000 - GUN_T_S) < 1.5, `the rider leaves the pen at the gun (${(moving.t / 1000 - GUN_T_S).toFixed(1)} s after it)`);
    assert.ok(Math.abs(line.t / 1000 - GUN_T_S - 19.3) < 1, `the distance starts ${(line.t / 1000 - GUN_T_S).toFixed(1)} s after the gun`);
    assert.ok(timer.t >= line.t && timer.t - line.t < 1500, 'the timer starts with the distance');
    assert.equal(home[0].d.remainingEnd, 6100);
});

test('the padded plan: the road places the rider, 429 m into the plan, and says so', () => {
    const run = replay(plans.padded);
    const locked = run.ticks.find(k => k.alignment?.locked);
    assert.ok(locked && locked.ed <= 300, `the course matches within 300 m of the line (event metre ${locked?.ed.toFixed(0)})`);
    const race = run.ticks.filter(k => k.status === 'racing' && k.alignment?.locked);
    assert.ok(race.length > 3000, `locked race ticks ${race.length}`);
    for (const k of race) {
        assert.ok(Math.abs(k.planM - (K * k.ed + PADDED_LINE_M)) <= 8, `plan metre ${k.planM.toFixed(1)} at event metre ${k.ed.toFixed(1)}`);
        assert.ok(Math.abs(k.alignment.outOfStepM - PADDED_LINE_M) <= 8, `out of step ${k.alignment.outOfStepM}`);
    }
    // The matched line wanders a few metres with the rider's line through the bends; the figure
    // the rider is shown is the one first found, the whole race.
    assert.ok(Math.max(...race.map(k => k.alignment.lineM)) - Math.min(...race.map(k => k.alignment.lineM)) > 5, 'the line moves');
    assert.equal(new Set(race.map(k => k.alignment.outOfStepM)).size, 1, 'one figure all race');
    assert.equal(run.log.filter(m => /^Plan out of step with the race: the road puts the timing line 4[23]\d m after where the plan has it/.test(m)).length, 1, run.log.join(' | '));
    assert.ok(run.log.some(m => /^Course matched: the timing line is 4[23]\d m into the plan$/.test(m)), run.log.join(' | '));
    for (const e of switchErrors(run, plans.padded, PADDED_LINE_M)) {
        assert.ok(e.lateS != null && Math.abs(e.lateS) <= SWITCH_LIMIT_S, `interval ${e.number} (${e.startM} m): switched ${e.lateS?.toFixed(1)} s from the road`);
    }
});

test('the padded plan as 0.9.2 placed it (by distance alone) was 31 to 123 s late: the measure of the fix', () => {
    // What the old line window did: no lock, plan metre = event metre. Against the same truth.
    const late = [];
    for (let i = 1; i < plans.padded.intervals.length; i++) {
        const startM = plans.padded.intervals[i].startM;
        late.push(crossingT(startM) - crossingT((startM - PADDED_LINE_M) / K));
    }
    assert.ok(Math.min(...late) > 30 && Math.max(...late) > 120 && Math.max(...late) < 125, `late by ${Math.min(...late).toFixed(0)} to ${Math.max(...late).toFixed(0)} s`);
});

test('the planner\'s plan: metre 0 is the timing line, in step, every switch on the road', () => {
    const plan = plans.planner;
    assert.equal(plan.lineSource, 'measured');
    assert.equal(plan.startLineM, 0);
    assert.ok(plan.course && plan.course.realFromM === 0, 'no padding before the start');
    const run = replay(plan);
    const race = run.ticks.filter(k => k.status === 'racing' && k.alignment?.locked);
    assert.ok(race.length > 3000, `locked race ticks ${race.length}`);
    const lines = race.map(k => k.alignment.lineM).sort((a, b) => a - b);
    assert.ok(Math.abs(lines[Math.floor(lines.length / 2)]) <= 3, `median line ${lines[Math.floor(lines.length / 2)].toFixed(1)} m`);
    assert.ok(run.ticks.every(k => k.alignment?.outOfStepM == null && !k.alignment?.unmatched), 'never out of step, never unmatched');
    for (const e of switchErrors(run, plan, 0)) {
        assert.ok(e.lateS != null && Math.abs(e.lateS) <= SWITCH_LIMIT_S, `interval ${e.number} (${e.startM} m): switched ${e.lateS?.toFixed(1)} s from the road`);
    }
});

test('the clock starts at the line; the result is from the gun, 19 s earlier', () => {
    const run = replay(plans.planner);
    const first = run.ticks.find(k => k.status === 'racing');
    const before = run.ticks[run.ticks.indexOf(first) - 1];
    assert.equal(before.status, 'armed', 'armed until the line, through the gun and the ride out of the pen');
    assert.ok(first.signal === 'distance' || first.signal === 'time', `started by the line (${first.signal}), not the gun`);
    assert.ok(first.ed > 0 && first.ed < 15, `the clock starts at the line (event metre ${first.ed.toFixed(1)})`);
    const gun = run.ticks.find(k => k.gunToLineS != null);
    assert.ok(gun && gun.t - first.t < 1.5, 'the gun is known as the clock starts');
    assert.ok(Math.abs(gun.gunToLineS - 18.8) <= 0.3, `gun to line ${gun.gunToLineS.toFixed(2)} s`);
    assert.ok(run.log.some(m => /^Mass start: the timing line was crossed 1[89]\.\d s after the gun/.test(m)), run.log.join(' | '));
    // While racing the predicted finish is on the result's clock; the plan's delta is not moved.
    const mid = run.ticks.find(k => k.status === 'racing' && k.ed > 3000);
    assert.ok(Math.abs(mid.officialTotalS - mid.totalS - gun.gunToLineS) < 1e-6);
    const finish = run.ticks.find(k => k.status === 'finished');
    assert.ok(Math.abs(finish.elapsedS - 686) <= 1, `from the line ${finish.elapsedS}`);
    assert.ok(Math.abs(finish.officialElapsedS - OFFICIAL_S) <= 0.6, `from the gun ${finish.officialElapsedS.toFixed(2)} against the result's ${OFFICIAL_S}`);
    assert.ok(Math.abs(finishFigure(run.view).seconds - OFFICIAL_S) <= 0.6 && finishFigure(run.view).label === 'finished', 'the finish cell shows the result\'s time');
    assert.ok(run.log.some(m => /^Finished: 70[45]\.\d s from the gun \(68[56]\.\d s from the timing line\)$/.test(m)), run.log.at(-1));
});

test('the event\'s details arriving late, or a window opened mid-race, still give the result\'s time', () => {
    const run = (joinS, infoS) => {
        const engine = createEngine({plan: plans.planner, prefs: {smoothingSec: 0}});
        let told = false;
        for (const row of home) {
            if (row.t / 1000 < joinS) {
                continue;
            }
            engine.tick(row.d, meta.startedAt + row.t);
            if (!told && row.t / 1000 >= infoS) {
                engine.event('eventInfo', {subgroupId: String(SUBGROUP), kind: 'group', startMs: meta.eventStartMs, name: 'Mass-start race'}, meta.startedAt + row.t);
                told = true;
            }
        }
        return engine.view();
    };
    // The details after the finish: the time is there at once, without waiting for a tick.
    const late = run(0, home.at(-1).t / 1000);
    assert.equal(late.status, 'finished');
    assert.ok(Math.abs(late.race.officialElapsedS - OFFICIAL_S) <= 0.6, `details after the finish: ${late.race.officialElapsedS}`);
    // A window opened three minutes into the race: Zwift's timer gives the crossing to the second.
    const joined = run(GUN_T_S + 180, 0);
    assert.equal(joined.race.signal, 'time');
    assert.ok(Math.abs(joined.race.gunToLineS - 18.8) <= 1, `joined mid-race: gun to line ${joined.race.gunToLineS}`);
    assert.ok(Math.abs(joined.race.officialElapsedS - OFFICIAL_S) <= 1.5, `joined mid-race: ${joined.race.officialElapsedS}`);
});

test('without the event\'s start, or as a TT, the times are from the line and nothing is added', () => {
    for (const opts of [{kind: 'group', startMs: null}, {kind: 'tt'}, {kind: null}]) {
        const run = replay(plans.planner, opts);
        const finish = run.ticks.find(k => k.status === 'finished');
        assert.ok(finish && Math.abs(finish.elapsedS - 686) <= 1, `${JSON.stringify(opts)}: ${finish?.elapsedS}`);
        assert.equal(finish.gunToLineS, null);
        assert.equal(finish.officialElapsedS, null);
        assert.ok(Math.abs(finishFigure(run.view).seconds - finish.elapsedS) < 1e-9);
    }
    // A start time that is not this race's (hours out) is not a gun.
    const odd = replay(plans.planner, {kind: 'group', startMs: meta.eventStartMs - 3600_000});
    assert.equal(odd.ticks.find(k => k.status === 'finished').gunToLineS, null);
});

test('the field in a mass start: every clock from the gun, the home rider\'s finish is the result', () => {
    const field = createField();
    let lengthM = null;
    for (const row of recording) {
        if (row.ch === 'athlete/watching') {
            lengthM = row.d.remainingMetric === 'distance' && row.d.remainingEnd > 0 ? row.d.remainingEnd : lengthM;
        } else if (row.ch === 'nearby') {
            ingest(field, row.d, meta.startedAt + row.t, {lineM: 0, kind: 'group', gunMs: meta.eventStartMs, lengthM});
        }
    }
    const homeRider = field.riders.get('1');
    assert.equal(homeRider.startSource, 'gun');
    assert.ok(homeRider.finished, 'the home rider finished');
    assert.ok(Math.abs(finishRaceOf(homeRider) - OFFICIAL_S) <= 1.5, `home finish ${finishRaceOf(homeRider)?.toFixed(1)} s against ${OFFICIAL_S}`);
    const list = rows(field, {nowMs: meta.startedAt + recording.at(-1).t});
    assert.ok(list.length >= 2, `rows ${list.length}`);
    for (const r of field.riders.values()) {
        const s = finishRaceOf(r);
        assert.ok(s == null || (s > 400 && s < 900), `rider ${r.id}: finish ${s} s is a race time from the gun`);
    }
});
