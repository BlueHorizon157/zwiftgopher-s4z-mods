// The planner's own plan file (zg-tt-plan/1 with route.course, written by the planner's measured
// course, 2026-11-10) through the mod's normalisePlan and engine on Dave's California Dreamin'
// recording. The plan's metre 0 is the timing line (route.start_line_m 0, line_source 'measured').
//
// The truth: the route data metre of a rider is 0.998656 x eventDistance + 160.17 (measured). The
// planner's line is 159.9 route-data metres, so the plan metre is 0.998656 x eventDistance + 0.27.
// The planner's course is the same road as the fixture course (test/fixtures/recordings/
// california-dreamin-2026-11-10.course.json, the old rule axis): checked point by point below.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {decodeCourse} from '../pages/src/engine/course.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const raw = JSON.parse(read('california-dreamin-2026-11-10.planner.plan.json'));
const fixtureCourse = decodeCourse(JSON.parse(read('california-dreamin-2026-11-10.course.json')));
const rows = parseJsonl(gunzipSync(readFileSync(new URL('california-dreamin-2026-11-10.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(rows);
const home = rows.filter(r => r.ch === 'athlete/watching');

const K = 0.998656;                 // route-data metres per game metre (measured)
const RULE_LINE_M = 160.17;         // the route-data metre of the timing line (measured)
const PLANNER_LINE_M = 159.9;       // the planner's measured line (route data metres)
const truth = ed => K * ed + (RULE_LINE_M - PLANNER_LINE_M);
const SPEC_SWITCH_S = 1.0;
const SWITCH_LIMIT_S = {9679: 1.5};   // one boundary on a ramp: the road is ~6 m from the formula there
const PLAN_END_M = 21128;

const plan = normalisePlan(raw);

/** Every home tick through the engine (the same reads the other recording tests make). */
function replay() {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    return home.map(row => {
        engine.tick(row.d, meta.startedAt + row.t);
        const v = engine.view();
        return {
            t: row.t, ed: row.d.state.eventDistance, remaining: row.d.remaining,
            status: v.status, planM: v.race.planM, running: v.race.running, elapsedS: v.race.elapsedS,
            targetIndex: v.target ? v.target.index : null, alignment: v.race.alignment,
            completed: v.race.completed, finishM: v.race.finishM,
        };
    });
}
const ticks = replay();
const firstLocked = ticks.find(k => k.alignment?.locked);
const raceTicks = ticks.filter(k => k.running && k.status === 'racing' && k.ed > 0 && k.remaining > 0 && k.alignment?.locked);

/** Wall time (ms from the recording's start) at which the rider's event distance reaches edStar. */
function crossingT(edStar) {
    let prev = null;
    for (const row of home) {
        const ed = row.d.state.eventDistance;
        if (!(ed > 0)) continue;
        if (ed >= edStar) {
            if (!prev) return row.t;
            return prev.t + (edStar - prev.ed) / (ed - prev.ed) * (row.t - prev.t);
        }
        prev = {t: row.t, ed};
    }
    return null;
}

/** Distance in metres from a point to the nearest segment of a decoded course (local plane). */
function distToCourse(c, lat, lng) {
    const R = 6371000, toR = Math.PI / 180;
    const kx = toR * R * Math.cos(lat * toR), ky = toR * R;
    let best = Infinity;
    for (let i = 0; i < c.count - 1; i++) {
        const ax = (c.lng[i] - lng) * kx, ay = (c.lat[i] - lat) * ky;
        const dx = (c.lng[i + 1] - lng) * kx - ax, dy = (c.lat[i + 1] - lat) * ky - ay;
        const L = dx * dx + dy * dy;
        const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
}

test('the plan file reads as a measured-line plan with a course on the plan metres', () => {
    assert.equal(plan.lineSource, 'measured');
    assert.equal(plan.startLineM, 0);
    assert.ok(plan.course, 'the course decodes');
    assert.equal(plan.course.count, 729);
    // The planner's constant (ROUTE_DATA_M_PER_GAME_M); the measured 0.998656 differs by ~2 m at the finish.
    assert.equal(plan.routeMPerGameM, 0.99856);
    assert.ok(Math.abs(plan.finishM - 21128.1) < 0.05, `finish ${plan.finishM}`);
    assert.ok(Math.abs(plan.lengthM - PLAN_END_M) < 0.5, `length ${plan.lengthM}`);
    assert.equal(plan.intervals.length, 18);
});

test('the planner course is the fixture course: every 10th point within 2 m of its road', () => {
    const c = plan.course;
    let worst = 0;
    for (let i = 0; i < c.count; i += 10) {
        worst = Math.max(worst, distToCourse(fixtureCourse, c.lat[i], c.lng[i]));
    }
    assert.ok(worst <= 2, `worst ${worst.toFixed(2)} m from the fixture road`);
});

test('the course locks within 300 m of the line, and the implied line is the planner\'s line (0 m)', () => {
    assert.ok(firstLocked, 'the course locked');
    assert.ok(firstLocked.ed >= 0 && firstLocked.ed <= 300, `locked at event distance ${firstLocked.ed}`);
    const lines = raceTicks.map(k => k.alignment.lineM).sort((a, b) => a - b);
    assert.ok(lines.length > 3000, `locked race ticks ${lines.length}`);
    const median = lines[Math.floor(lines.length / 2)];
    assert.ok(Math.abs(median) <= 2, `median implied line ${median.toFixed(2)} m against 0`);
    for (const l of lines) {
        assert.ok(Math.abs(l) <= 7, `implied line ${l.toFixed(2)} m against 0`);
    }
});

test('after the lock the plan metre is the road metre on at least 99 % of the race ticks', () => {
    const race = raceTicks.filter(k => k.t >= firstLocked.t);
    const errs = race.map(k => Math.abs(k.planM - truth(k.ed))).sort((a, b) => a - b);
    const share = errs.filter(e => e <= 6).length / errs.length;
    assert.ok(share >= 0.99, `${(share * 100).toFixed(2)} % of ${race.length} race ticks within 6 m`);
    assert.ok(errs.at(-1) <= 7, `worst ${errs.at(-1).toFixed(2)} m`);
});

test('every interval switch is within a second of the rider reaching its metre (one ramp: 1.5 s)', () => {
    let last = null;
    const switches = [];
    for (const k of ticks) {
        if (k.targetIndex !== last && k.targetIndex != null) {
            switches.push({index: k.targetIndex, t: k.t});
            last = k.targetIndex;
        }
    }
    // The engine's target index is 0-based: interval i (from 1) is the target from its start.
    for (let i = 1; i < plan.intervals.length; i++) {
        const iv = plan.intervals[i];
        const sw = switches.find(s => s.index === i);
        const ct = crossingT((iv.startM - (RULE_LINE_M - PLANNER_LINE_M)) / K);
        assert.ok(sw && ct != null, `switch to interval ${i} (0-based) found`);
        const err = (sw.t - ct) / 1000;
        const bound = SWITCH_LIMIT_S[Math.round(iv.startM)] ?? SPEC_SWITCH_S;
        assert.ok(Math.abs(err) <= bound, `switch at ${iv.startM} m: ${err.toFixed(2)} s`);
    }
});

test('the finish: the distance to go is spent past the plan\'s end, and the clock reads 2095 s', () => {
    const finish = ticks.find(k => k.status === 'finished');
    assert.ok(finish, 'finished');
    assert.ok(finish.remaining <= 0, `remaining ${finish.remaining} at the finish`);
    const before = ticks[ticks.indexOf(finish) - 1];
    assert.ok(before.remaining > 0, 'the tick before still had distance to go');
    assert.ok(finish.planM > PLAN_END_M, `finish at plan metre ${finish.planM}, past the plan's end`);
    assert.ok(Math.abs(finish.planM - truth(finish.ed)) <= 6, `finish metre ${finish.planM} against ${truth(finish.ed).toFixed(2)}`);
    assert.ok(Math.abs(finish.elapsedS - 2095) <= 1, `clock at the finish ${finish.elapsedS}`);
    assert.equal(finish.completed, plan.intervals.length, 'every interval completed');
});
