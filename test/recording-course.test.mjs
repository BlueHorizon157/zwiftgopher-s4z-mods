// The course tracker on Dave's first real mod recording (Zwift TT "California Dreamin'", route
// 966890401, 2026-11-10): the plan metre against the measured road, the interval switches against
// the true crossings, the finish, and the finished latch. The plan without a course keeps the old
// rule and is late by the line, as it was on the ride.
//
// The truth: the route data metre of a rider is 0.998656 x eventDistance + 160.17 (the planner's
// course matched to the rider's lat/lng: residual sd 1.65 m, max 5 m). The plan's metres are the
// route data's metres from its first point.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const plan0 = JSON.parse(readFileSync(new URL('california-dreamin-2026-11-10.plan.json', dir), 'utf8'));
const course = JSON.parse(readFileSync(new URL('california-dreamin-2026-11-10.course.json', dir), 'utf8'));
const rows = parseJsonl(gunzipSync(readFileSync(new URL('california-dreamin-2026-11-10.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(rows);
const home = rows.filter(r => r.ch === 'athlete/watching');

const K = 0.998656;            // the measured route-data metres per game metre
const LINE = 160.17;           // the route data metre of the timing line
const truth = ed => K * ed + LINE;
const withCourse = {...plan0, route: {...plan0.route, course, route_m_per_game_m: K}};
const SPEC_SWITCH_S = 1.0;
// The boundary at 10059 m is a bend where the road and the planner's formula differ by 5 m (the
// tracker follows the road; the switch is 0.5 s after the road reaches it, the formula says 1.4 s).
const BEND_SWITCH_S = 1.5;
const BEND_M = 10059;

/** Every home tick: the rider's distance and the engine's view of it (only what the checks read). */
function replay(plan) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    const out = [];
    for (const row of home) {
        engine.tick(row.d, meta.startedAt + row.t);
        const v = engine.view();
        out.push({
            t: row.t,
            ed: row.d.state.eventDistance,
            remaining: row.d.remaining,
            subgroup: row.d.state.eventSubgroupId ?? row.d.eventSubgroupId ?? null,
            status: v.status,
            planM: v.race.planM,
            running: v.race.running,
            elapsedS: v.race.elapsedS,
            targetIndex: v.target ? v.target.index : null,
            alignment: v.race.alignment,
            completed: v.race.completed,
            finishM: v.race.finishM,
            log: v.log.length,
            engine,
        });
    }
    return out;
}

// The first tick the course reports a rider on the road (the lock).
const firstLocked = ticks => ticks.find(k => k.alignment?.locked);
const raceTicks = ticks => ticks.filter(k => k.running && k.status === 'racing' && k.ed > 0 && k.remaining > 0);

/** Wall time (ms from the recording's start) at which the rider's event distance reaches edStar. */
function crossingT(edStar) {
    let prev = null;
    for (const row of home) {
        const ed = row.d.state.eventDistance;
        if (!(ed > 0)) {
            continue;
        }
        if (ed >= edStar) {
            if (!prev) {
                return row.t;
            }
            return prev.t + (edStar - prev.ed) / (ed - prev.ed) * (row.t - prev.t);
        }
        prev = {t: row.t, ed};
    }
    return null;
}

/** For each interval after the first: the wall time its target first shows, and the true crossing. */
function switches(ticks) {
    const out = [];
    let last = null;
    for (const k of ticks) {
        if (k.targetIndex !== last && k.targetIndex != null) {
            out.push({index: k.targetIndex, t: k.t, planM: k.planM});
            last = k.targetIndex;
        }
    }
    return plan0.intervals.slice(1).map((iv, i) => {
        const sw = out.find(s => s.index === i + 1);
        const ct = crossingT((iv.start_m - LINE) / K);
        return {boundaryM: iv.start_m, errS: sw && ct != null ? (sw.t - ct) / 1000 : null};
    });
}

const ticksCourse = replay(withCourse);

test('the course locks within 300 m of the line, and the implied line is the measured one', () => {
    const lock = firstLocked(ticksCourse);
    assert.ok(lock, 'the course locked');
    assert.ok(lock.ed >= 0 && lock.ed <= 300, `locked at event distance ${lock.ed}`);
    const lines = raceTicks(ticksCourse).filter(k => k.alignment?.locked).map(k => k.alignment.lineM);
    assert.ok(lines.length > 3000, `locked race ticks ${lines.length}`);
    // The median is the line; single ticks wander with the road's local deviation (the formula's 5 m).
    const sorted = [...lines].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(Math.abs(median - LINE) <= 1, `median implied line ${median.toFixed(2)} against ${LINE}`);
    for (const l of lines) {
        assert.ok(Math.abs(l - LINE) <= 7, `implied line ${l.toFixed(2)} against ${LINE}`);
    }
});

test('after the lock the plan metre is the road metre on at least 99 % of the race ticks', () => {
    const lock = firstLocked(ticksCourse);
    const race = raceTicks(ticksCourse).filter(k => k.t >= lock.t && k.alignment?.locked);
    const within = race.filter(k => Math.abs(k.planM - truth(k.ed)) <= 6);
    const share = within.length / race.length;
    assert.ok(share >= 0.99, `${(share * 100).toFixed(2)} % of ${race.length} race ticks within 6 m`);
    const sorted = race.map(k => Math.abs(k.planM - truth(k.ed))).sort((a, b) => a - b);
    assert.ok(sorted.at(-1) <= 7, `worst ${sorted.at(-1).toFixed(2)} m`);
});

test('every interval switch is within a second of the rider reaching its metre (one bend: 1.5 s)', () => {
    const sw = switches(ticksCourse);
    assert.equal(sw.length, plan0.intervals.length - 1);
    for (const s of sw) {
        assert.ok(s.errS != null, `switch at ${s.boundaryM} found`);
        const bound = s.boundaryM === BEND_M ? BEND_SWITCH_S : SPEC_SWITCH_S;
        assert.ok(Math.abs(s.errS) <= bound, `switch at ${s.boundaryM} m: ${s.errS.toFixed(2)} s`);
    }
});

test('the finish: Sauce\'s distance to go is spent, past the plan\'s end, at the rider\'s 2095 s', () => {
    const finish = ticksCourse.find(k => k.status === 'finished');
    assert.ok(finish, 'finished');
    assert.ok(finish.remaining <= 0, `remaining ${finish.remaining} at the finish`);
    const before = ticksCourse[ticksCourse.indexOf(finish) - 1];
    assert.ok(before.remaining > 0, 'the tick before still had distance to go');
    assert.ok(finish.planM > plan0.intervals.at(-1).end_m, `finish at plan metre ${finish.planM}, past the plan's end`);
    assert.ok(Math.abs(finish.elapsedS - 2095) <= 1, `clock at the finish ${finish.elapsedS}`);
    assert.equal(finish.completed, plan0.intervals.length, 'every interval completed, the last one at the finish');
});

test('the finished state survives the rider leaving the event: result and statistics kept', () => {
    const finish = ticksCourse.find(k => k.status === 'finished');
    const after = ticksCourse.filter(k => k.t > finish.t);
    const left = after.find(k => !k.subgroup);
    assert.ok(left, 'the subgroup went to none after the finish');
    for (const k of after) {
        assert.equal(k.status, 'finished', `still finished at ${k.t}`);
        assert.equal(k.elapsedS, finish.elapsedS, 'the finish time is held');
        assert.equal(k.completed, plan0.intervals.length, 'the statistics are held');
    }
    const log = left.engine.view().log.map(l => l.msg);
    assert.ok(log.some(m => /kept/.test(m)), 'the latch is in the log');
    // Out of the event the course is not in the view: the alignment says it is not matched now.
    for (const k of after.filter(x => !x.subgroup)) {
        assert.equal(k.alignment.locked, false, `alignment after the finish at ${k.t}`);
        assert.notEqual(k.alignment.mode, 'course', `alignment mode after the finish at ${k.t}`);
    }
});

test('the plan without a course runs on the old rule: no crash, late by the line, finished by Sauce', () => {
    const ticks = replay(plan0);
    assert.equal(firstLocked(ticks), undefined, 'no course, no lock');
    const finish = ticks.find(k => k.status === 'finished');
    assert.ok(finish && finish.remaining <= 0, 'finished by Sauce\'s distance to go');
    const sw = switches(ticks).filter(s => s.errS != null);
    const lateness = sw.map(s => s.errS).sort((a, b) => a - b);
    const median = lateness[Math.floor(lateness.length / 2)];
    assert.ok(median > 10, `median switch lateness ${median.toFixed(1)} s (the old rule's 15 s on this ride)`);
    assert.equal(ticks.at(-1).alignment.mode, 'line');
});

/**
 * The home rows with a change made to each (a deep copy: the fixture is not touched). change(d, t)
 * edits the athlete entry in place and returns false to drop the row.
 */
function changed(change) {
    const out = [];
    for (const row of home) {
        const d = JSON.parse(JSON.stringify(row.d));
        if (change(d, row.t) !== false) {
            out.push({...row, d});
        }
    }
    return out;
}

/** The engine over rows (the same as replay(), for changed rows). */
function replayRows(plan, rowsIn) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    return rowsIn.map(row => {
        engine.tick(row.d, meta.startedAt + row.t);
        const v = engine.view();
        return {t: row.t, ed: row.d.state.eventDistance, status: v.status, planM: v.race.planM, running: v.race.running,
            targetIndex: v.target ? v.target.index : null, completed: v.race.completed, alignment: v.race.alignment, elapsedS: v.race.elapsedS,
            remaining: row.d.remaining, log: v.log.map(l => l.msg)};
    });
}

/** The plan metre never goes back while racing, and the statistics never run ahead of the target. */
function assertMonotone(ticks, label) {
    let last = null;
    for (const k of ticks) {
        if (!k.running || k.status !== 'racing' || k.planM == null) {
            continue;
        }
        if (last != null) {
            assert.ok(k.planM >= last - 1e-6, `${label}: the plan metre went back at ${k.t} (${last.toFixed(1)} to ${k.planM.toFixed(1)})`);
        }
        last = k.planM;
        assert.ok(k.completed <= k.targetIndex, `${label}: ${k.completed} intervals completed while the target is ${k.targetIndex} at ${k.t}`);
    }
}

test('a kilometre without lat/lng after the line: the switches stay within a second, the metre never goes back', () => {
    const rowsGap = changed((d) => {
        if (d.state.eventDistance > 19000 && d.state.eventDistance <= 20000) {
            delete d.state.latlng;
        }
    });
    const ticks = replayRows(withCourse, rowsGap);
    assertMonotone(ticks, 'gap after the line');
    const sw = switches(ticks).filter(s => s.errS != null);
    const late = sw.filter(s => s.boundaryM > 19000 && s.boundaryM < 20000);
    assert.ok(late.length >= 1, 'a boundary lies in the gap');
    for (const s of late) {
        assert.ok(Math.abs(s.errS) <= SPEC_SWITCH_S, `switch at ${s.boundaryM} in the gap: ${s.errS.toFixed(2)} s`);
    }
});

test('a stretch without lat/lng from 10000 m: the metre never steps back, the interval in progress is not closed early', () => {
    const rowsGap = changed((d) => {
        if (d.state.eventDistance > 10000 && d.state.eventDistance <= 10700) {
            delete d.state.latlng;
        }
    });
    const ticks = replayRows(withCourse, rowsGap);
    assertMonotone(ticks, 'stretch lost');
});

test('one eventDistance of 0 mid-race is a dropped reading: the metre does not drop back about 145 m', () => {
    let done = false;
    const rowsGlitch = changed((d) => {
        if (!done && d.state.eventDistance > 5000) {
            d.state.eventDistance = 0;
            done = true;
        }
    });
    const ticks = replayRows(withCourse, rowsGlitch);
    assertMonotone(ticks, 'a zero reading');
    const sw = switches(ticks).filter(s => s.errS != null);
    for (const s of sw) {
        assert.ok(Math.abs(s.errS) <= 1.5, `switch at ${s.boundaryM} with a zero reading: ${s.errS.toFixed(2)} s`);
    }
});

test('a null distance to go is no reading: the race does not finish at its first tick', () => {
    const rowsNull = changed((d) => {
        d.remaining = null;
    });
    const ticks = replayRows(withCourse, rowsNull.slice(0, 400));
    assert.ok(ticks.every(k => k.status !== 'finished'), 'not finished with no distance to go');
    assert.ok(ticks.some(k => k.status === 'racing'), 'racing');
});

// A seeded PRNG (the same numbers every run) for the perturbations below.
function rng(seed) {
    let x = seed >>> 0;
    return () => {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 4294967296;
    };
}

test('5 m of fix noise: every switch within a second, the metre never goes back', () => {
    const r = rng(7);
    const rowsNoise = changed((d) => {
        const ll = d.state.latlng;
        if (ll) {
            // Box-Muller: a normal offset of sd 5 m in north and east.
            const a = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) * 5;
            const b = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) * 5;
            d.state.latlng = [ll[0] + a / 111320, ll[1] + b / (111320 * Math.cos(ll[0] * Math.PI / 180))];
        }
    });
    const ticks = replayRows(withCourse, rowsNoise);
    assertMonotone(ticks, 'noise');
    for (const s of switches(ticks).filter(x => x.errS != null)) {
        const bound = s.boundaryM === BEND_M ? BEND_SWITCH_S : SPEC_SWITCH_S;
        assert.ok(Math.abs(s.errS) <= bound, `switch at ${s.boundaryM} with noise: ${s.errS.toFixed(2)} s`);
    }
});

test('30 % of the position fixes dropped: the metre never goes back, and each switch within 2 s', () => {
    const r = rng(7);
    const rowsDrop = changed(() => (r() < 0.3 ? false : undefined));
    const ticks = replayRows(withCourse, rowsDrop);
    assertMonotone(ticks, 'drop');
    for (const s of switches(ticks).filter(x => x.errS != null)) {
        assert.ok(Math.abs(s.errS) <= 2, `switch at ${s.boundaryM} with 30 % dropped: ${s.errS.toFixed(2)} s`);
    }
});

test('a position 2 km off for 100 m of odometer (a teleport): no switch is late, and the metre does not go back', () => {
    const rowsTele = changed((d) => {
        const ll = d.state.latlng;
        if (ll && d.state.eventDistance > 8000 && d.state.eventDistance <= 8100) {
            d.state.latlng = [ll[0] + 0.02, ll[1] + 0.02];
        }
    });
    const ticks = replayRows(withCourse, rowsTele);
    assertMonotone(ticks, 'teleport');
    for (const s of switches(ticks).filter(x => x.errS != null)) {
        assert.ok(Math.abs(s.errS) <= SPEC_SWITCH_S + 0.5, `switch at ${s.boundaryM} after a teleport: ${s.errS.toFixed(2)} s`);
    }
});
