// Time left in the interval (countdown.mjs, Dave 2026-11-10): counts down a second a
// second, a hill inside an interval does not move it, the rider's power in the interval
// does (a dip of a few seconds hardly), and a draft is learnt.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan, timeInto} from '../pages/src/engine/plan.mjs';
import {createTracking, advance, timeExponent, planTimeAtMetre} from '../pages/src/engine/tracking.mjs';
import {createCountdown, advanceCountdown, speedFactor} from '../pages/src/engine/countdown.mjs';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const load = name => normalisePlan(JSON.parse(readFileSync(new URL(`./fixtures/plans/${name}`, import.meta.url), 'utf8')));
const rollers = load('rollers.fit.optimise.json');
const climb = load('climb.fit.optimise.json');

/**
 * Rides a plan one tick a second from metre 0. speedOf(iv, t, planM) and powerOf(iv, t,
 * planM) give the rider's speed (m/s) and power; by default the plan's own. Returns every
 * tick with the countdown and, once ridden, when its interval really ended.
 */
function ride(plan, {speedOf = iv => iv.speedMs, powerOf = iv => iv.powerW, untilM = plan.lengthM} = {}) {
    const intervals = plan.intervals;
    const tracking = createTracking();
    const cd = createCountdown();
    const ticks = [];
    let planM = 0;
    let raceS = 0;
    let index = 0;
    while (planM < untilM) {
        while (index < intervals.length - 1 && planM >= intervals[index].endM) {
            index++;
        }
        const iv = intervals[index];
        const power = powerOf(iv, raceS, planM);
        advance(tracking, {index, raceS, power, planM, intervals, atStart: raceS === 0});
        const r = advanceCountdown(cd, {intervals, index, planM, raceS, power, tracking, riderKg: plan.weightKg});
        const speed = speedOf(iv, raceS, planM);
        ticks.push({index, raceS, planM, speed, ...r});
        const next = planM + speed;
        // When the interval's end is crossed, by interpolation inside this second.
        if (planM < iv.endM && next >= iv.endM) {
            iv.endedS = raceS + (iv.endM - planM) / speed;
        }
        planM = next;
        raceS += 1;
    }
    for (const t of ticks) {
        t.truthS = intervals[t.index].endedS != null ? intervals[t.index].endedS - t.raceS : null;
    }
    for (const iv of intervals) {
        delete iv.endedS;
    }
    return ticks;
}

/** Per-tick steps of the shown figure inside each interval (negative: it went down). */
function steps(ticks) {
    const out = [];
    for (let i = 1; i < ticks.length; i++) {
        if (ticks[i].index === ticks[i - 1].index) {
            out.push({index: ticks[i].index, step: ticks[i].leftS - ticks[i - 1].leftS, at: ticks[i]});
        }
    }
    return out;
}

test('riding the plan, it is the plan\'s time left and counts down a second a second', () => {
    const ticks = ride(rollers);
    for (const s of steps(ticks)) {
        if (s.at.truthS > 1) {
            assert.ok(Math.abs(s.step + 1) < 0.05, `interval ${s.index + 1} at ${s.at.raceS} s stepped ${s.step.toFixed(2)}`);
        }
    }
    for (const t of ticks.filter(x => x.truthS != null)) {
        assert.ok(Math.abs(t.leftS - t.truthS) < 1.5, `interval ${t.index + 1} at ${t.raceS} s: ${t.leftS.toFixed(1)} vs ${t.truthS.toFixed(1)}`);
    }
});

test('a hill inside an interval: a second a second, where speed over the metres leapt', () => {
    // The long first interval, ridden at the plan's average but slow in its middle third
    // and fast either side (a drag up and down inside one power).
    const iv0 = rollers.intervals[0];
    const third = iv0.lengthM / 3;
    const speedOf = (iv, t, m) => iv !== iv0 ? iv.speedMs : m < iv0.startM + third || m >= iv0.startM + 2 * third ? iv.speedMs * 1.25 : iv.speedMs * 0.7;
    const ticks = ride(rollers, {speedOf, untilM: iv0.endM + 1});
    const mine = steps(ticks).filter(s => s.index === 0);
    // It learns the rider's speed in the interval too, so a second can stretch or shrink a
    // little (a draft is learnt the same way), never leap.
    const worst = Math.max(...mine.map(s => Math.abs(s.step + 1)));
    assert.ok(worst < 0.75, `worst step off a second ${worst.toFixed(2)} s`);
    assert.ok(mine.every(s => s.step < 0), 'never goes up');
    // The old figure, metres over the speed of the moment, leapt where the speed changed.
    const old = ticks.filter(t => t.index === 0).map(t => (iv0.endM - t.planM) / t.speed);
    const leap = Math.max(...old.slice(1).map((v, i) => Math.abs(v - old[i] + 1)));
    assert.ok(leap > 15, `the speed-based figure leapt ${leap.toFixed(1)} s`);
    // And it still reaches nought at the change.
    const last = ticks.filter(t => t.index === 0).at(-1);
    assert.ok(last.leftS < 2, `${last.leftS.toFixed(1)} s left on the last tick before the change`);
});

test('the rider\'s power in the interval moves it; a dip of a few seconds hardly', () => {
    // The 10 % climb (interval 2 of the climb plan, about six minutes).
    const iv = climb.intervals[1];
    const e = timeExponent(iv, climb.weightKg);
    const mid = iv.startM + iv.lengthM / 2;
    const at = (ticks) => ticks.find(t => t.index === 1 && t.planM >= mid);
    const steady = at(ride(climb, {untilM: mid + 1}));

    // Five seconds at half power in the middle (the speed holds: inertia).
    let dipFrom = null;
    const dipped = at(ride(climb, {
        untilM: mid + 50,
        powerOf: (v, t, m) => {
            if (v === iv && m >= mid - 5 * v.speedMs && dipFrom == null) {
                dipFrom = t;
            }
            return v === iv && dipFrom != null && t < dipFrom + 5 ? v.powerW * 0.5 : v.powerW;
        },
    }));
    assert.ok(Math.abs(dipped.leftS - steady.leftS) < 3, `a 5 s dip moved it ${(dipped.leftS - steady.leftS).toFixed(1)} s`);

    // 10 % under the target the whole interval, and the speed that gives.
    const under = v => v === iv ? 0.9 : 1;
    const slow = at(ride(climb, {powerOf: v => v.powerW * under(v), speedOf: v => v.speedMs * Math.pow(under(v), e), untilM: iv.endM + 1}));
    const planLeft = iv.durationS * (iv.endM - slow.planM) / iv.lengthM;
    assert.ok(slow.leftS > planLeft * 1.05, `held 10 % under: ${slow.leftS.toFixed(0)} s vs the plan's ${planLeft.toFixed(0)} s`);
    assert.ok(Math.abs(slow.leftS - slow.truthS) < 0.03 * slow.truthS, `${slow.leftS.toFixed(0)} s vs ${slow.truthS.toFixed(0)} s to go`);
});

test('a draft: faster than the plan at its power, learnt over a few minutes', () => {
    const ticks = ride(rollers, {speedOf: iv => iv.speedMs * 1.2});
    const late = ticks.filter(t => t.raceS > 360 && t.truthS > 10);
    assert.ok(late.length > 50);
    assert.ok(late.every(t => t.speed > 1.12), `speed factor ${Math.min(...late.map(t => t.speed)).toFixed(3)}`);
    const err = late.reduce((s, t) => s + Math.abs(t.leftS - t.truthS) / t.truthS, 0) / late.length;
    assert.ok(err < 0.06, `mean error ${(err * 100).toFixed(1)} %`);
});

// The rollers plan with time marks on its first interval (1310 m): its first 600 m flat and
// quick (30 % of the time), the rest a drag (70 %), as the planner writes them (time_marks).
const SPLIT_M = 600;
function withMarks() {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/plans/rollers.fit.optimise.json', import.meta.url), 'utf8'));
    const iv = raw.intervals[0];
    const len = iv.end_m - iv.start_m;
    const marks = [];
    for (let m = 200; m < len - 50; m += 200) {
        const share = m <= SPLIT_M ? 0.3 * m / SPLIT_M : 0.3 + 0.7 * (m - SPLIT_M) / (len - SPLIT_M);
        marks.push([m, Math.round(10 * iv.duration_s * share) / 10]);
    }
    iv.time_marks = marks;
    return normalisePlan(raw);
}

test('time marks: where in the interval its time goes', () => {
    const plan = withMarks();
    const iv = plan.intervals[0];
    assert.ok(iv.marks.length > 5);
    assert.equal(timeInto(iv, iv.startM), 0);
    assert.equal(timeInto(iv, iv.endM), iv.durationS);
    assert.ok(Math.abs(timeInto(iv, iv.startM + SPLIT_M) - 0.3 * iv.durationS) < 0.1, 'the quick 600 m, 30 % of the time');
    assert.ok(Math.abs(timeInto(iv, iv.startM + 300) - 0.15 * iv.durationS) < 0.1, 'between marks, evenly');
    assert.ok(Math.abs(planTimeAtMetre(plan.intervals, iv.startM + SPLIT_M) - (iv.startTimeS + 0.3 * iv.durationS)) < 0.1);
    // Without marks, evenly; marks out of order or outside the interval are not used.
    assert.equal(timeInto(rollers.intervals[0], rollers.intervals[0].startM + rollers.intervals[0].lengthM / 2), rollers.intervals[0].durationS / 2);
    const raw = JSON.parse(readFileSync(new URL('./fixtures/plans/rollers.fit.optimise.json', import.meta.url), 'utf8'));
    for (const bad of [[[400, 50], [200, 60]], [[200, 50], [400, 40]], [[200, 1e6]], [[1e7, 5]], 'x', [[200]]]) {
        raw.intervals[0].time_marks = bad;
        assert.equal(normalisePlan(raw).intervals[0].marks, null, JSON.stringify(bad));
    }
});

test('time marks: a quick start and a slow finish to an interval count down in seconds', () => {
    const plan = withMarks();
    const iv0 = plan.intervals[0];
    const split = iv0.startM + SPLIT_M;
    // Ridden as planned: quick on the first 600 m, slow on the rest.
    const speedOf = (iv, t, m) => iv !== iv0 ? iv.speedMs : m < split ? SPLIT_M / (0.3 * iv0.durationS) : (iv0.lengthM - SPLIT_M) / (0.7 * iv0.durationS);
    const ticks = ride(plan, {speedOf, untilM: iv0.endM + 1}).filter(t => t.index === 0 && t.truthS != null);
    const worst = Math.max(...ticks.map(t => Math.abs(t.leftS - t.truthS)));
    assert.ok(worst < 1.5, `worst ${worst.toFixed(1)} s from the truth`);
    // Spread evenly the figure would be well out at the split (30 % of the time gone, 46 % of the metres).
    const atSplit = ticks.find(t => t.planM >= split);
    const even = iv0.durationS * (iv0.endM - atSplit.planM) / iv0.lengthM;
    assert.ok(Math.abs(even - atSplit.truthS) > 15, `even ${even.toFixed(1)} s vs ${atSplit.truthS.toFixed(1)} s`);
    // (Bar the second that crosses the split: the simulator rides all of it at the quick speed.)
    for (const s of steps(ticks).filter(x => x.at !== atSplit)) {
        assert.ok(Math.abs(s.step + 1) < 0.2, `stepped ${s.step.toFixed(2)} at ${s.at.raceS} s`);
    }
});

test('nothing ridden yet: the plan\'s speed', () => {
    assert.equal(speedFactor(createTracking(), rollers.intervals, 0, 0, 72), 1);
});

test('the engine shows it while racing: next in, the time left, and the ring by time', () => {
    const plan = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
    const rows = parseJsonl(readFileSync(new URL('./fixtures/telemetry/synthetic-flat-tt.jsonl', import.meta.url), 'utf8'));
    const epoch = metaOf(rows).startedAt;
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    let prev = null;
    let checked = 0;
    for (const row of rows.filter(r => r.ch === 'athlete/watching')) {
        engine.tick(row.d, epoch + row.t);
        const v = engine.view();
        if (v.status !== 'racing' || !v.target || !v.next) {
            prev = null;
            continue;
        }
        assert.equal(v.next.inS, v.target.toNextS);
        assert.ok(v.target.timeProgress >= 0 && v.target.timeProgress <= 1);
        if (prev && prev.target.index === v.target.index && v.next.inS > 2) {
            assert.ok(Math.abs(v.next.inS - prev.next.inS + 1) < 0.2, `step ${(v.next.inS - prev.next.inS).toFixed(2)} at ${row.t} ms`);
            assert.ok(v.target.timeProgress >= prev.target.timeProgress);
            checked++;
        }
        prev = v;
    }
    assert.ok(checked > 300, `${checked} ticks checked`);
});
