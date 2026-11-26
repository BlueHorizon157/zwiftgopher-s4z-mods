// The engine audit before 1.0.0 (2026-11-26): one regression test for each defect found, on the
// recorded races where there is one (Crit Cross 2026-11-23, the Hilly Route mass start 2026-11-11,
// California Dreamin' 2026-11-10) and on small synthetic rides where not. Each test fails on the
// engine as it was audited and passes with the fix.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import * as engineModule from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {createTracking, advance} from '../pages/src/engine/tracking.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const {createEngine} = engineModule;
const JOIN_WAIT_MS = engineModule.JOIN_WAIT_MS ?? 30000;
const dir = new URL('./fixtures/recordings/', import.meta.url);
const recordings = new Map();
const recordingOf = name => {
    if (!recordings.has(name)) {
        const rows = parseJsonl(gunzipSync(readFileSync(new URL(`${name}.jsonl.gz`, dir))).toString('utf8'));
        recordings.set(name, {rows, meta: metaOf(rows), home: rows.filter(r => r.ch === 'athlete/watching')});
    }
    return recordings.get(name);
};
const planFile = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));

const CASES = {
    crit: {rec: 'crit-cross-2026-11-23', plan: 'crit-cross-2026-11-23.plan.json', kind: 'tt'},
    critm: {rec: 'crit-cross-2026-11-23', plan: 'crit-cross-2026-11-23.measured.plan.json', kind: 'tt'},
    cd0: {rec: 'california-dreamin-2026-11-10', plan: 'california-dreamin-2026-11-10.plan.json', kind: 'tt'},
    hilly: {rec: 'hilly-race-2026-11-11', plan: 'hilly-race-2026-11-11.planner.plan.json', kind: 'group'},
};

/**
 * A recording through an engine. edit(tick, i) may change a tick (return null to lose it);
 * at(engine, i) runs after each fed tick (a rider's reset, a plan arriving); the event's
 * kind and start arrive after the first tick, as Sauce's RPC answers.
 */
function replay(name, {edit = null, at = null, plan = undefined, eventInfoAt = 0} = {}) {
    const c = CASES[name];
    const {rows, meta, home} = recordingOf(c.rec);
    const info = rows.find(r => r.ch === 'rpc' && r.d.method === 'getEventSubgroup')?.d.result
        ?? {id: home.find(h => h.d.state.eventSubgroupId).d.state.eventSubgroupId, eventSubgroupStart: meta.eventStartMs, name: 'x'};
    const engine = createEngine({plan: plan === undefined ? normalisePlan(planFile(c.plan)) : plan, prefs: {smoothingSec: 0}});
    const out = [];
    home.forEach((row, i) => {
        const d = edit ? edit(structuredClone(row.d), i) : row.d;
        if (d === null) {
            return;
        }
        engine.tick(d, meta.startedAt + row.t);
        if (i === eventInfoAt) {
            engine.event('eventInfo', {subgroupId: String(info.id), kind: c.kind, startMs: info.eventSubgroupStart, name: info.name}, meta.startedAt + row.t);
        }
        at?.(engine, i, meta.startedAt + row.t);
        out.push({i, v: engine.view()});
    });
    return {engine, out, home, meta, raw: planFile(c.plan)};
}

const leaveEvent = d => {
    d.eventSubgroupId = 0;
    d.state.eventSubgroupId = 0;
    return d;
};

// ---- 1. the join that never ends ----

test('1: the subgroup dropping out for a few ticks mid-race does not freeze the race', () => {
    const base = replay('crit');
    const {engine, out} = replay('crit', {edit: (d, i) => (i >= 400 && i < 405 ? leaveEvent(d) : d)});
    assert.equal(out.find(o => o.i === 399).v.status, 'racing');
    assert.equal(out.find(o => o.i === 410).v.status, 'racing', 'racing again a few ticks after the subgroup is back, not waiting for a pen');
    assert.equal(engine.view().status, 'finished');
    assert.ok(Math.abs(engine.state.finishS - base.engine.state.finishS) < 2, `finish ${engine.state.finishS} against ${base.engine.state.finishS}`);
});

test('1: a race joined in progress (window open on the free ride before) starts after the wait', () => {
    const base = replay('crit');
    const joinAt = 300;
    const {engine, out} = replay('crit', {edit: (d, i) => {
        if (i < joinAt) {
            d.remainingType = 'route';
            return leaveEvent(d);
        }
        return d;
    }});
    // Crit Cross ticks are a second apart: the clock starts on the first tick past the wait.
    const waitTicks = Math.ceil(JOIN_WAIT_MS / 1000);
    assert.equal(out.find(o => o.i === joinAt + 2).v.status, 'armed', 'still waiting for the pen just after joining');
    assert.equal(out.find(o => o.i === joinAt + waitTicks + 3).v.status, 'racing');
    assert.equal(engine.view().status, 'finished');
    assert.ok(Math.abs(engine.state.finishS - base.engine.state.finishS) < 2, 'on Zwift\'s timer as it stands');
});

test('1: a tick from another world than the join began in is the event\'s own, not a stale one', () => {
    // The ticks after joining still carry the warm-up's course until Zwift moves the rider; the
    // first tick with another course, running, is the race (here a late join onto Crit Cross).
    const joinAt = 300;
    const {out} = replay('crit', {edit: (d, i) => {
        if (i < joinAt) {
            d.remainingType = 'route';
            d.state.courseId = 99;
            return leaveEvent(d);
        }
        if (i === joinAt) {
            d.state.courseId = 99;      // the first tick in the subgroup is still the warm-up's
        }
        return d;
    }});
    assert.equal(out.find(o => o.i === joinAt).v.status, 'armed');
    assert.equal(out.find(o => o.i === joinAt + 3).v.status, 'racing', 'the course changed: the race is on');
});

// ---- 2. a free ride's route remaining is not an event's length ----

test('2: a plan from here on a route finishes at the plan\'s end with Sauce\'s route remaining on the ticks', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
    const ROUTE = '3395698268';
    const L = 10710;
    fixture.meta.from_here = {kind: 'route', remaining_m: L, start_wbal_fraction: 0.4, cp_factor: 0.95, bike: 'road', bike_reason: 'drafted',
        anchor: {ride_m: 50000, world_ms: 1.7e12, subgroup_id: null, route_id: ROUTE}};
    const engine = createEngine({plan: normalisePlan(fixture, {code: 'HERE01'}), prefs: {smoothingSec: 0}});
    const seen = new Set();
    for (let s = 0; s <= 1100; s++) {
        engine.tick({
            athleteId: 1, self: true,
            state: {distance: 50000 + s * 12, worldTime: 1.7e12 + s * 1000, routeId: ROUTE, speed: 43.2, power: 280, eventSubgroupId: null, eventDistance: 0, time: 0},
            remaining: Math.max(0, L - s * 12), remainingMetric: 'distance', remainingType: 'route', remainingEnd: L,
        }, 1.7e12 + s * 1000);
        seen.add(engine.view().status);
    }
    assert.deepEqual([...seen], ['racing', 'finished']);
});

test('2: a plan on its route on a free ride is not cut at the route\'s lap or flagged as another distance', () => {
    // The free ticks of the California Dreamin' recording: remainingType 'route', remainingEnd one lap (19075 m).
    const {engine, out} = replay('cd0', {edit: (d, i) => {
        d.state.eventDistance = 0;
        d.state.time = 0;
        d.remainingType = 'route';
        d.remainingEnd = 19074.99;
        d.remaining = Math.max(0, 19074.99 - d.state.distance);
        return leaveEvent(d);
    }});
    const mid = out[2000].v;
    assert.equal(mid.status, 'racing');
    assert.equal(mid.event.mismatchM, null, 'no "plan for another distance" on a free ride');
    assert.equal(mid.race.finishM, mid.plan.lengthM, 'the plan\'s own end');
    assert.equal(engine.view().status, 'finished', 'at the plan\'s end');
});

// ---- 3. a gap in the ticks over an interval boundary ----

test('3: a gap in the ticks over an interval boundary does not skew ahead or behind', () => {
    const base = replay('crit');
    const deltaAt = (run, i) => run.out.find(o => o.i === i)?.v.race.deltaS;
    // Crit Cross changes interval at tick 300 and 338 (a tick a second).
    for (const [at, len] of [[299, 3], [299, 6], [299, 30], [337, 10]]) {
        const run = replay('crit', {edit: (d, i) => (i >= at && i < at + len ? null : d)});
        let worst = 0;
        for (let i = at + len; i <= at + len + 300; i += 10) {
            worst = Math.max(worst, Math.abs(deltaAt(run, i) - deltaAt(base, i)));
        }
        assert.ok(worst < 2.5, `gap of ${len} ticks over the boundary at ${at + 1}: off by up to ${worst.toFixed(1)} s`);
    }
});

test('3: the interval left closes at the crossing, not at the tick after the gap', () => {
    const base = replay('crit');
    const run = replay('crit', {edit: (d, i) => (i >= 299 && i < 305 ? null : d)});
    const left = base.engine.state.tracking.stats[0];
    const gapped = run.engine.state.tracking.stats[0];
    assert.ok(Math.abs(gapped.endRaceS - left.endRaceS) < 1.5, `interval 1 ended at ${gapped.endRaceS} against ${left.endRaceS}`);
    assert.ok(Math.abs(run.engine.state.tracking.stats[1].startRaceS - base.engine.state.tracking.stats[1].startRaceS) < 1.5);
});

// ---- 4. a mass start whose plan arrives after the event's info ----

test('4: a mass start keeps its gun time and kind when the plan is loaded after the event info', () => {
    const c = CASES.hilly;
    const {rows, meta, home} = recordingOf(c.rec);
    const sg = home.find(h => h.d.state.eventSubgroupId).d.state.eventSubgroupId;
    assert.ok(rows.length > 0);
    const engine = createEngine({plan: null, prefs: {smoothingSec: 0}});
    home.forEach((row, i) => {
        engine.tick(row.d, meta.startedAt + row.t);
        if (i === 0) {
            engine.event('eventInfo', {subgroupId: String(sg), kind: 'group', startMs: meta.eventStartMs, name: 'x'}, meta.startedAt + row.t);
        }
        if (i === 5) {
            engine.event('plan', {plan: planFile(c.plan), code: 'AAAAAA'}, meta.startedAt + row.t);
        }
    });
    const v = engine.view();
    assert.equal(v.status, 'finished');
    assert.equal(v.event.kind, 'group');
    assert.equal(v.event.startMs, meta.eventStartMs);
    assert.ok(Math.abs(v.race.gunToLineS - 18.8) < 0.3, `gun to line ${v.race.gunToLineS}`);
    assert.ok(Math.abs(v.race.officialElapsedS - 704.9) < 0.5, `official ${v.race.officialElapsedS}`);
});

// ---- 5. reset after the finish ----

test('5: Reset after the finish does not finish the same event again; the next real start races', () => {
    const {engine, home, meta} = replay('crit');
    const finishS = engine.state.finishS;
    assert.equal(engine.view().status, 'finished');
    const last = home.at(-1);
    let t = last.t;
    const d = structuredClone(last.d);
    const feed = (n, step) => {
        for (let k = 0; k < n; k++) {
            t += 1000;
            d.state.worldTime += 1000;
            step();
            engine.tick(structuredClone(d), meta.startedAt + t);
        }
    };
    engine.event('reset', {}, meta.startedAt + t + 500);
    // The rider spins on after the finish: the timer and distance run on, remaining stays spent.
    feed(120, () => {
        d.state.time += 1;
        d.state.eventDistance += 5;
        d.state.distance += 5;
        d.state.speed = 18;
        d.state.power = 120;
    });
    let v = engine.view();
    assert.notEqual(v.status, 'finished', `a new finish at ${engine.state.finishS} (the real one was ${finishS})`);
    assert.notEqual(v.status, 'racing');
    assert.equal(v.race.running, false);
    // A real start: the pen's zero timer and distance, then the line.
    feed(3, () => {
        d.state.time = 0;
        d.state.eventDistance = 0;
        d.state.distance = 0;
        d.state.speed = 0;
        d.remaining = d.remainingEnd;
    });
    assert.equal(engine.view().status, 'armed');
    feed(5, () => {
        d.state.time += 1;
        d.state.eventDistance += 10;
        d.state.distance += 10;
        d.state.speed = 36;
        d.remaining = d.remainingEnd - d.state.eventDistance;
    });
    v = engine.view();
    assert.equal(v.status, 'racing');
    assert.ok(v.race.elapsedS < 10, `the clock started at the line: ${v.race.elapsedS}`);
});

test('5: a new event after Reset races as usual', () => {
    const {engine, home, meta} = replay('crit');
    engine.event('reset', {}, meta.startedAt + home.at(-1).t + 500);
    const pen = structuredClone(home[0].d);
    pen.eventSubgroupId = 777;
    pen.state.eventSubgroupId = 777;
    let t = home.at(-1).t;
    for (let k = 0; k < 5; k++) {
        t += 1000;
        pen.state.worldTime = home.at(-1).d.state.worldTime + (k + 1) * 1000;
        engine.tick(structuredClone(pen), meta.startedAt + t);
    }
    assert.equal(engine.view().status, 'armed');
    pen.state.time = 1;
    pen.state.eventDistance = 12;
    pen.state.speed = 40;
    pen.state.worldTime += 1000;
    engine.tick(structuredClone(pen), meta.startedAt + t + 1000);
    assert.equal(engine.view().status, 'racing');
});

// ---- 6. one stray tick of "remaining 0" ----

test('6: one tick of remaining 0 in the middle of the race does not end it', () => {
    const base = replay('crit');
    const {engine, out} = replay('crit', {edit: (d, i) => {
        if (i === 300) {
            d.remaining = 0;
        }
        return d;
    }});
    assert.equal(out.find(o => o.i === 301).v.status, 'racing');
    assert.equal(engine.view().status, 'finished');
    assert.equal(engine.state.finishS, base.engine.state.finishS, 'the real finish is where it was');
});

// ---- 7. leaving the event ----

test('7: leaving the pen for the plan\'s own route arms the plan on the route', () => {
    const {out} = replay('crit', {edit: (d, i) => {
        if (i >= 5) {
            d.remainingType = 'route';
            d.state.eventDistance = 0;
            d.state.time = 0;
            return leaveEvent(d);
        }
        d.state.eventDistance = 0;
        d.state.time = 0;
        d.state.distance = 0;
        return d;
    }});
    const v = out[100].v;
    assert.equal(v.status, 'racing');
    assert.equal(v.race.signal, 'manual');
    assert.ok(v.race.planM != null);
    assert.ok(v.race.running);
});

// ---- 8. the plan's signature ----

test('8: the same plan sent again with its course, finish or W\' and CP changed is a new plan', () => {
    const raw = planFile(CASES.critm.plan);
    const old = structuredClone(raw);
    delete old.route.course;
    delete old.route.finish_source;
    delete old.route.finish_m;
    const engine = createEngine({plan: normalisePlan(old, {code: 'AAAAAA'})});
    assert.equal(engine.state.plan.course, null);
    engine.event('plan', {plan: raw, code: 'AAAAAA'});
    assert.ok(engine.state.plan.course, 'the course arrives');
    assert.equal(engine.state.plan.finishSource, 'measured');
    const edited = structuredClone(raw);
    edited.rider.wprime_used_j = 15000;
    edited.rider.cp_used = 230;
    edited.rider.cp_wbal = 230;
    engine.event('plan', {plan: edited, code: 'AAAAAA'});
    assert.equal(engine.state.plan.wPrimeJ, 15000);
    assert.equal(engine.state.plan.cp, 230);
    // The identical file is still nothing.
    const before = engine.state.plan;
    engine.event('plan', {plan: edited, code: 'AAAAAA'});
    assert.equal(engine.state.plan, before);
});

// ---- 9. the finish's own figures; a power dropout ----

test('9: after the finish the total and the ahead or behind are the finish\'s own', () => {
    for (const name of ['crit', 'critm', 'hilly']) {
        const {engine} = replay(name);
        const v = engine.view();
        assert.equal(v.status, 'finished');
        assert.equal(v.race.totalS, engine.state.finishS, `${name}: total ${v.race.totalS} against the finish ${engine.state.finishS}`);
        assert.equal(v.race.remainingS, 0);
        assert.ok(Math.abs(v.race.deltaS - (engine.state.finishS - v.race.planTimeFromStartS)) < 1e-6, `${name}: delta ${v.race.deltaS}`);
    }
});

test('9: ticks with no power are not counted as 0 W in an interval\'s average', () => {
    const intervals = [{startM: 0, endM: 1000, lengthM: 1000, durationS: 100, powerW: 300}];
    const tr = createTracking();
    const step = (raceS, power) => advance(tr, {index: 0, raceS, power, planM: raceS * 10, intervals, atStart: true});
    step(0, 300);
    step(1, 300);
    for (let s = 2; s < 12; s++) {
        step(s, null);
    }
    step(12, 300);
    step(13, 300);
    assert.ok(Math.abs(tr.stats[0].avgPowerW - 300) < 1e-9, `average ${tr.stats[0].avgPowerW}`);
    assert.equal(tr.stats[0].elapsedS, 13, 'the time still counts');
});

test('9: a rider whose power drops out for half a minute keeps the interval average they rode', () => {
    const base = replay('crit');
    const run = replay('crit', {edit: (d, i) => {
        if (i >= 100 && i < 130) {
            d.state.power = null;
        }
        return d;
    }});
    const a = base.engine.state.tracking.stats[0].avgPowerW;
    const b = run.engine.state.tracking.stats[0].avgPowerW;
    assert.ok(Math.abs(a - b) < 6, `interval 1 averaged ${b.toFixed(1)} W against ${a.toFixed(1)}`);
    assert.equal(run.out.find(o => o.i === 110).v.live.rawPowerW, null, 'no reading is no reading, not 0 W');
});
