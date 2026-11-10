// The course tracker (pages/src/engine/course.mjs) on synthetic courses: the zg-course/1 decode,
// the projection onto the road, a course that crosses itself, a course that repeats per lap,
// padding that is not road, bad positions, and the output never going backwards.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeCourse, candidatesAt, createCourseTracker, advanceCourse, courseMetre, scaleOf,
    LINE_MAX_M, LOCK_FIXES, maxStepM, MAX_SPEED_MS, STEP_SLACK_M,
} from '../pages/src/engine/course.mjs';

const R = 6371000;
const LAT0 = 51.5;
const LNG0 = -0.12;
const KY = R * Math.PI / 180;
const KX = KY * Math.cos(LAT0 * Math.PI / 180);
const toLatLng = (x, y) => [LAT0 + y / KY, LNG0 + x / KX];

/** A path in local metres, sampled finely, with the metre at each sample (the plan's axis). */
function pathOf(xy, startM = 0) {
    const m = [startM];
    for (let i = 1; i < xy.length; i++) {
        m.push(m[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    }
    return {xy, m};
}

/** Where the path is at a metre (linear between samples). */
function atM(path, metre) {
    const {m, xy} = path;
    const i = Math.max(0, Math.min(m.length - 2, m.findIndex((v, j) => j > 0 && v >= metre) - 1));
    const t = m[i + 1] > m[i] ? (metre - m[i]) / (m[i + 1] - m[i]) : 0;
    return [xy[i][0] + t * (xy[i + 1][0] - xy[i][0]), xy[i][1] + t * (xy[i + 1][1] - xy[i][1])];
}

/** The planner's form: every `step`-th sample, the metres x 10 and the positions x 1e6, delta-coded. */
function encode(path, {step = 10, realFromM = 0, realToM = null, count = null} = {}) {
    const idx = [];
    for (let i = 0; i < path.m.length; i += step) {
        idx.push(i);
    }
    if (idx.at(-1) !== path.m.length - 1) {
        idx.push(path.m.length - 1);
    }
    const pts = idx.map(i => ({m: path.m[i], ...latLngObj(path.xy[i])}));
    const delta = vals => vals.map((v, i) => i === 0 ? v : v - vals[i - 1]);
    return {
        format: 'zg-course/1',
        count: count ?? pts.length,
        m: delta(pts.map(p => Math.round(p.m * 10))),
        lat: delta(pts.map(p => Math.round(p.lat * 1e6))),
        lng: delta(pts.map(p => Math.round(p.lng * 1e6))),
        ele: delta(pts.map(() => 0)),
        real_from_m: realFromM,
        real_to_m: realToM ?? pts.at(-1).m,
    };
}
const latLngObj = xy => {
    const [lat, lng] = toLatLng(xy[0], xy[1]);
    return {lat, lng};
};

/** A straight road running east, `len` metres from x0. */
const straight = (len, y = 0, x0 = 0, step = 5) => {
    const xy = [];
    for (let x = 0; x <= len; x += step) {
        xy.push([x0 + x, y]);
    }
    return pathOf(xy);
};

/** A figure of eight: the road crosses itself at the origin (metres 0 and 2 A pi per loop). */
function figureOfEight(A = 300, n = 720) {
    const xy = [];
    for (let i = 0; i <= n; i++) {
        const th = i / n * 2 * Math.PI;
        xy.push([A * Math.sin(th), A * Math.sin(th) * Math.cos(th)]);
    }
    return pathOf(xy);
}

/** A rider on the course: the odometer's ticks (Sauce's distance from the line) and the fixes. */
function ride(path, {lineM, k = 1, fromEd = 0, toEd, stepEd = 4, noiseM = 1.5}) {
    const ticks = [];
    for (let ed = fromEd; ed <= toEd; ed += stepEd) {
        const metre = lineM + k * ed;
        const [x, y] = atM(path, metre);
        const jitter = noiseM * Math.sin(ed * 0.37);
        const [lat, lng] = toLatLng(x + jitter, y - jitter * 0.5);
        ticks.push({ed, metre, lat, lng});
    }
    return ticks;
}

test('decodes the zg-course/1 block; sound or nothing', () => {
    const path = straight(1000);
    const good = encode(path);
    const c = decodeCourse(good);
    assert.equal(c.count, good.count);
    assert.ok(Math.abs(c.m[c.count - 1] - 1000) < 0.2, `last metre ${c.m[c.count - 1]}`);
    assert.ok(Math.abs(c.lat[0] - toLatLng(0, 0)[0]) < 1e-6);
    assert.equal(c.realToM, good.real_to_m);
    assert.equal(decodeCourse(null), null);
    assert.equal(decodeCourse({...good, format: 'zg-course/2'}), null, 'another format');
    assert.equal(decodeCourse({...good, count: 1}), null, 'fewer than two points');
    assert.equal(decodeCourse({...good, count: good.count + 1}), null, 'a count that does not match the arrays');
    assert.equal(decodeCourse({...good, m: good.m.map((v, i) => i === 3 ? -5 : v)}), null, 'a metre that goes backwards');
    assert.equal(decodeCourse({...good, lat: good.lat.map((v, i) => i === 2 ? 1.5 : v)}), null, 'a fraction');
    assert.equal(decodeCourse({...good, lng: good.lng.map((v, i) => i === 0 ? NaN : v)}), null, 'a non-finite value');
    assert.equal(decodeCourse({...good, lat: [...good.lat.slice(0, -1), 90e6 * 2]}), null, 'a latitude off the globe');
    assert.equal(decodeCourse({...good, real_to_m: -1}), null, 'a real road that ends before it starts');
    assert.equal(decodeCourse({...good, real_from_m: 500, real_to_m: 400}), null);
});

test('scales outside 0.9 to 1.1 are not used', () => {
    assert.equal(scaleOf(0.998656), 0.998656);
    assert.equal(scaleOf(1.5), null);
    assert.equal(scaleOf(null), null);
    assert.equal(scaleOf('x'), null);
});

test('the projection: a fix on the road gives its metre and a small offset; off the road none', () => {
    const c = decodeCourse(encode(straight(1000)));
    const [lat, lng] = toLatLng(437, 0.5);
    const [hit] = candidatesAt(c, lat, lng);
    assert.ok(Math.abs(hit.m - 437) < 0.5, `metre ${hit.m}`);
    assert.ok(hit.offset < 0.6, `offset ${hit.offset}`);
    const [far] = toLatLng(437, 60);
    assert.deepEqual(candidatesAt(c, far, toLatLng(437, 60)[1]), [], 'sixty metres off the road');
});

test('a self-crossing course: the crossing has both passes on the plan, each with its metre', () => {
    // The path passes the origin at its start (metre ~0, and again where the loop closes) and at
    // the half-way point (metre ~914.6): every place within the search radius of the origin.
    const path = figureOfEight(300, 720);
    const c = decodeCourse(encode(path, {step: 4}));
    const metres = candidatesAt(c, ...toLatLng(0, 0)).map(x => x.m);
    const halfWay = path.m.at(-1) / 2;
    assert.ok(metres.some(m => Math.abs(m - halfWay) < 3), `a pass at the half way metre ${halfWay.toFixed(1)}: ${metres.map(m => m.toFixed(1))}`);
    assert.ok(metres.some(m => m < 3 || m > path.m.at(-1) - 3), 'the start pass');
});

test('a figure of eight: the rider is locked on the pass they ride, not the other', () => {
    const path = figureOfEight(300, 720);
    const c = decodeCourse(encode(path, {step: 4}));
    const lineM = 40;
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    const ticks = ride(path, {lineM, toEd: 900});
    let locked = null;
    for (const t of ticks) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
        if (tr.justLocked) {
            locked = t;
        }
        if (tr.locked) {
            assert.ok(Math.abs(tr.m - t.metre) <= 3, `at ed ${t.ed}: ${tr.m.toFixed(1)} against ${t.metre.toFixed(1)}`);
        }
    }
    assert.ok(locked && locked.ed <= 100, `locked at ${locked?.ed}`);
    assert.ok(Math.abs(tr.lineM - lineM) <= 3, `implied line ${tr.lineM}`);
});

test('a course of two laps: the repeat a lap later is not taken for the line', () => {
    const lap = 1000;
    const xy = [];
    const loop = straight(lap);
    const ring = [...loop.xy];
    // The lap: out along the road, then back on the same road (the course repeats per lap).
    const back = straight(lap).xy.map(([x, y]) => [lap - x, y + 0]);
    const oneLap = [...ring, ...back.slice(1)];
    xy.push(...oneLap);
    xy.push(...oneLap.slice(1));
    const path = pathOf(xy);
    const c = decodeCourse(encode(path, {step: 5}));
    const lineM = 60;
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    for (const t of ride(path, {lineM, toEd: 600, stepEd: 5})) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
    }
    assert.ok(tr.locked, 'locked');
    assert.ok(Math.abs(tr.lineM - lineM) <= 3, `line ${tr.lineM} against ${lineM}`);
    assert.ok(tr.lineM < LINE_MAX_M, 'not the second lap\'s line');
});

test('padding before the route data is not road: no lock on it, the rider locks on the road after', () => {
    // 200 m of padding running north, then the road running east from its end.
    const pad = [];
    for (let y = 0; y <= 200; y += 5) {
        pad.push([0, y]);
    }
    const road = [];
    for (let x = 5; x <= 1500; x += 5) {
        road.push([x, 200]);
    }
    const path = pathOf([...pad, ...road]);
    const c = decodeCourse(encode(path, {step: 10, realFromM: 200, realToM: 1500}));
    assert.equal(c.realFromM, 200);
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    // The rider's fixes on the padding (metres 0 to 200) with the odometer near the line.
    for (const t of ride({xy: pad.map(([x, y]) => [x, y]), m: pad.map((_, i) => i * 5)}, {lineM: 0, toEd: 100, stepEd: 5})) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
    }
    assert.equal(tr.locked, false, 'the padding is never matched');
    assert.equal(courseMetre(tr), null);
    // Then the road: the rider locks, on the road's metres.
    for (const t of ride(path, {lineM: 200, fromEd: 0, toEd: 200, stepEd: 5})) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
    }
    assert.ok(tr.locked, 'locked on the road');
    assert.ok(Math.abs(tr.lineM - 200) <= 3, `line ${tr.lineM}`);
});

test('a rider with no position (missing, nonsense, the null island) never locks; the old rule stays', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    const inputs = [
        {lat: undefined, lng: undefined}, {lat: null, lng: null}, {lat: NaN, lng: 5}, {lat: 0, lng: 0},
        {lat: 200, lng: 0}, {lat: 'x', lng: 'y'},
    ];
    for (let ed = 0; ed < 300; ed += 5) {
        for (const p of inputs) {
            advanceCourse(tr, {...p, eventM: ed, lineHintM: 0});
            assert.equal(tr.locked, false);
            assert.equal(courseMetre(tr), null);
        }
    }
});

test('a locked metre never goes backwards while the rider moves, even on a jittery fix', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    let last = null;
    const ticks = ride(path, {lineM: 30, toEd: 500, stepEd: 4, noiseM: 6});
    for (const t of ticks) {
        // Jitter the fix backwards by 8 m now and then (a bad fix on the road).
        const back = Math.floor(t.ed) % 24 === 0 ? -8 : 0;
        const [lat, lng] = toLatLng(t.metre + back, 0);
        advanceCourse(tr, {lat, lng, eventM: t.ed, lineHintM: 0});
        if (tr.locked) {
            if (last != null) {
                assert.ok(tr.m >= last - 1e-9, `at ed ${t.ed}: ${tr.m} after ${last}`);
            }
            last = tr.m;
        }
    }
    assert.ok(tr.locked);
});

test('locking takes a few fixes spread over some odometer, not one', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    const [lat, lng] = toLatLng(50, 0);
    for (let i = 0; i < LOCK_FIXES + 2; i++) {
        advanceCourse(tr, {lat, lng, eventM: 2, lineHintM: 0});
    }
    assert.equal(tr.locked, false, 'the same spot, no odometer: not locked');
});

test('the odometer scale is used between fixes: a 0.5 % shorter route is followed', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 0.995});
    const ticks = ride(path, {lineM: 20, k: 0.995, toEd: 600, stepEd: 4, noiseM: 1});
    for (const t of ticks) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
        if (tr.locked) {
            assert.ok(Math.abs(tr.m - t.metre) <= 3, `at ed ${t.ed}: ${tr.m.toFixed(2)} against ${t.metre.toFixed(2)}`);
        }
    }
    assert.ok(tr.locked);
});

test('lost: no accepted fix for 600 m of odometer unlocks it; the fixes lock it again', () => {
    const path = straight(1500);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    for (const t of ride(path, {lineM: 10, toEd: 200, stepEd: 4})) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
    }
    assert.ok(tr.locked);
    // Fixes 200 m off the road: no accepted fix for 650 m of odometer.
    let unlocked = false;
    for (let ed = 200; ed <= 900; ed += 4) {
        const [lat, lng] = toLatLng(ed + 10, 200);
        advanceCourse(tr, {lat, lng, eventM: ed, lineHintM: 0});
        if (tr.justUnlocked) {
            unlocked = true;
        }
    }
    assert.ok(unlocked && !tr.locked, 'unlocked');
    // Lost, the line is kept and the metre is carried on the odometer (not dropped to nothing).
    assert.equal(tr.carried, true);
    assert.ok(Math.abs(courseMetre(tr) - (10 + 900)) <= 3, `carried metre ${courseMetre(tr)}`);
    for (const t of ride(path, {lineM: 10, fromEd: 900, toEd: 1100, stepEd: 4})) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
    }
    assert.ok(tr.locked, 'locked again');
    assert.ok(Math.abs(tr.lineM - 10) <= 3, `line ${tr.lineM}`);
});

/** Feed a rider's ticks; returns the metre after each tick (null before a lock or carry). */
function feed(tr, ticks) {
    const out = [];
    for (const t of ticks) {
        advanceCourse(tr, {lat: t.lat, lng: t.lng, eventM: t.ed, lineHintM: 0});
        out.push(courseMetre(tr));
    }
    return out;
}

test('a kilometre lost after the line keeps the line: the metre runs on, never backwards, and the relock agrees', () => {
    const path = straight(2500);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    feed(tr, ride(path, {lineM: 10, toEd: 200, stepEd: 4}));
    assert.ok(tr.locked);
    // No position for a kilometre of odometer (the feed dropped the rider's lat/lng).
    const lost = [];
    for (let ed = 204; ed <= 1200; ed += 4) {
        advanceCourse(tr, {lat: NaN, lng: NaN, eventM: ed, lineHintM: 0});
        lost.push({ed, m: courseMetre(tr), locked: tr.locked});
    }
    assert.ok(lost.some(x => !x.locked), 'lost for a while');
    for (const x of lost) {
        assert.ok(x.m != null, `metre carried at ed ${x.ed}`);
        assert.ok(Math.abs(x.m - (10 + x.ed)) <= 3, `carried ${x.m.toFixed(2)} against ${10 + x.ed} at ed ${x.ed}`);
    }
    // The fixes come back: the rider relocks on the road near the same line.
    const back = feed(tr, ride(path, {lineM: 10, fromEd: 1204, toEd: 1400, stepEd: 4}));
    assert.ok(tr.locked, 'relocked');
    assert.ok(Math.abs(tr.lineM - 10) <= 3, `relocked line ${tr.lineM}`);
    const seq = [...lost.map(x => x.m), ...back];
    for (let i = 1; i < seq.length; i++) {
        assert.ok(seq[i] >= seq[i - 1] - 1e-9, `metre went back at step ${i}: ${seq[i - 1]} to ${seq[i]}`);
    }
});

test('a zero event distance once racing is a dropped reading: the metre does not step back to the line', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    feed(tr, ride(path, {lineM: 10, toEd: 300, stepEd: 4}));
    const before = courseMetre(tr);
    advanceCourse(tr, {lat: NaN, lng: NaN, eventM: 0, lineHintM: 0});
    assert.ok(tr.locked, 'still locked after one dropped reading');
    assert.ok(courseMetre(tr) >= before - 1e-9, `metre ${courseMetre(tr)} after ${before}`);
    const next = feed(tr, ride(path, {lineM: 10, fromEd: 304, toEd: 340, stepEd: 4}));
    assert.ok(Math.abs(next.at(-1) - (10 + 340)) <= 3, `metre ${next.at(-1)} after the zero`);
});

test('an odometer step no rider could ride is held for one tick; the next tick decides', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    feed(tr, ride(path, {lineM: 10, toEd: 200, stepEd: 4}));
    const [lat, lng] = toLatLng(210, 0);
    advanceCourse(tr, {lat, lng, eventM: 5011, lineHintM: 0, dtS: 1});
    assert.ok(Math.abs(courseMetre(tr) - (10 + 200)) <= 3, `held: ${courseMetre(tr)}`);
    assert.ok(tr.locked, 'one bad step does not unlock');
    // The reading comes back to the rider's real distance: the odometer carries on from there.
    advanceCourse(tr, {lat, lng, eventM: 204, lineHintM: 0, dtS: 1});
    assert.ok(Math.abs(courseMetre(tr) - (10 + 204)) <= 3, `after the bad step: ${courseMetre(tr)}`);
});

test('a step that persists over two ticks is a real jump and is taken', () => {
    const path = straight(3000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    feed(tr, ride(path, {lineM: 10, toEd: 200, stepEd: 4}));
    const [lat, lng] = toLatLng(1000, 0);
    advanceCourse(tr, {lat, lng, eventM: 1000, lineHintM: 0, dtS: 1});
    advanceCourse(tr, {lat, lng, eventM: 1004, lineHintM: 0, dtS: 1});
    assert.ok(courseMetre(tr) > 900, `the jump was taken: ${courseMetre(tr)}`);
});

test('the step bound allows two seconds of riding and a burst of distance, not a jump of thousands of metres', () => {
    assert.equal(maxStepM(0.5), MAX_SPEED_MS * 2 + STEP_SLACK_M, 'bursts over half a second are allowed');
    assert.equal(maxStepM(1), MAX_SPEED_MS * 2 + STEP_SLACK_M);
    assert.equal(maxStepM(null), MAX_SPEED_MS * 2 + STEP_SLACK_M);
    assert.ok(maxStepM(10) > 300, 'a long gap in the feed allows a long step');
    assert.ok(maxStepM(1) < 5000);
});

test('a fix 20 m off the road never locks the course (the road is 10 m or less from the rider)', () => {
    const path = straight(1000);
    const c = decodeCourse(encode(path));
    const tr = createCourseTracker(c, {routeMPerGameM: 1});
    for (let ed = 0; ed <= 600; ed += 4) {
        const [lat, lng] = toLatLng(ed + 10, 20);
        advanceCourse(tr, {lat, lng, eventM: ed, lineHintM: 0});
    }
    assert.equal(tr.locked, false);
    assert.equal(tr.locks, 0);
});
