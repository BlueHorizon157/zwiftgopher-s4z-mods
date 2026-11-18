// The finish prediction (docs/REVAMP_PLAN.md 6.1): a clock offset is carried, not
// extrapolated; the rest of the race is timed from the rider's power through each
// interval's physics and the speed against the plan they have shown (2026-11-18); a shorter
// event ends the prediction at its own distance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {createTracking, advance, predict, timeExponent, powerRatio, speedAgainstPlan, POWER_PRIOR_S, POWER_WINDOW_S, START_SKIP_S} from '../pages/src/engine/tracking.mjs';

const plan = normalisePlan(JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8')));
const intervals = plan.intervals;

// Rides the plan at its own speeds, one tick a second, from the clock start at metre 0.
// clockOffsetS: seconds the race clock had already run at metre 0 (a clock from the gate
// when the timer starts later). powerScale: actual / plan power, held on every interval.
// speedScale: the rider's speed against the plan's at the power ridden (a draft, a planner off).
function ride({clockOffsetS = 0, powerScale = 1, speedScale = 1, untilM = plan.lengthM, onTick = null, finishM = null} = {}) {
    const tracking = createTracking();
    let planM = 0;
    let raceS = clockOffsetS;
    let t = 0;
    const out = [];
    while (planM < untilM) {
        const iv = intervals.find(x => planM >= x.startM && planM < x.endM) ?? intervals.at(-1);
        const index = intervals.indexOf(iv);
        // A few % more power on the flat gives a third of that in speed.
        const speed = iv.speedMs * Math.pow(powerScale, timeExponent(iv, plan.weightKg)) * speedScale;
        advance(tracking, {index, raceS, power: iv.powerW * powerScale, planM, intervals, atStart: t === 0, startLineM: 0});
        const p = predict({tracking, plan, index, planM, raceS, planTimeAtStart: 0, finishM});
        out.push({t, planM, index, p});
        onTick?.(out.at(-1));
        planM += speed;
        raceS += 1;
        t += 1;
    }
    return out;
}

test('a clock that started 10 s early stays 10 s behind, never extrapolated', () => {
    const ticks = ride({clockOffsetS: 10});
    const atBoundaries = ticks.filter((x, i) => i > 0 && x.index !== ticks[i - 1].index);
    assert.ok(atBoundaries.length >= 5);
    for (const x of ticks) {
        assert.ok(x.p.deltaS >= 8 && x.p.deltaS <= 13, `t=${x.t} delta ${x.p.deltaS.toFixed(1)}`);
        assert.ok(Math.abs(x.p.deficitS - 10) < 2, `t=${x.t} deficit ${x.p.deficitS.toFixed(1)}`);
        assert.ok(Math.abs(x.p.pacing - 1) < 0.01, `t=${x.t} power ratio ${x.p.pacing}`);
    }
    // No step when an interval closes: the old time ratio made one here.
    for (let i = 1; i < ticks.length; i++) {
        assert.ok(Math.abs(ticks[i].p.deltaS - ticks[i - 1].p.deltaS) < 1.5, `t=${ticks[i].t} jumped ${(ticks[i].p.deltaS - ticks[i - 1].p.deltaS).toFixed(1)} s`);
    }
});

test('riding the plan exactly predicts the plan all the way', () => {
    const ticks = ride();
    for (const x of ticks) {
        assert.ok(Math.abs(x.p.deltaS) <= 2, `t=${x.t} delta ${x.p.deltaS.toFixed(1)}`);
    }
    assert.ok(Math.abs(ticks.at(-1).p.totalS - plan.timeS) <= 2);
});

test('2.5 % over target on the flat reads a little ahead, more as the sample grows', () => {
    const ticks = ride({powerScale: 1.025});
    const start = ticks[START_SKIP_S].p;
    const early = ticks[60].p;
    const later = ticks[600].p;
    // The first seconds after the line count for nothing (the launch): only the time already gained.
    assert.equal(start.pacing, 1);
    assert.ok(start.deltaS <= 0 && start.deltaS > -2, `at ${START_SKIP_S} s: ${start.deltaS.toFixed(1)}`);
    assert.ok(early.deltaS <= 0 && early.deltaS > -12, `at 60 s: ${early.deltaS.toFixed(1)}`);
    assert.ok(later.deltaS < early.deltaS, `at 600 s: ${later.deltaS.toFixed(1)} vs ${early.deltaS.toFixed(1)}`);
    // Shrunk towards 1 until minutes of sample: 30 s of it carries under a tenth of its weight.
    assert.ok(early.pacing > 1 && early.pacing < 1 + 0.025 * 30 / (30 + POWER_PRIOR_S) + 0.001, `early ratio ${early.pacing}`);
    // 570 s of sample: about two thirds.
    const w = 570 / (570 + POWER_PRIOR_S);
    assert.ok(Math.abs(later.pacing - (1 + 0.025 * w)) < 0.002, `later ratio ${later.pacing}`);
    // At the plan's speed for the power: no speed term.
    assert.ok(Math.abs(later.speed - 1) < 0.01, `speed ${later.speed}`);
    // The whole race at 2.5 % over on flat ground: around 0.8 % faster.
    const gain = -ticks.at(-1).p.deltaS;
    assert.ok(gain > 0.004 * plan.timeS && gain < 0.012 * plan.timeS, `finished ${gain.toFixed(1)} s ahead of ${plan.timeS}`);
});

test('4 % faster than the plan at its power (a draft, a plan a little off) reads ahead within minutes', () => {
    const ticks = ride({speedScale: 1.04});
    const finalS = ticks.at(-1).p.deltaS;
    assert.ok(finalS < -0.03 * plan.timeS, `finished ${finalS.toFixed(1)} s`);
    // The power is the plan's, so only the speed says it: most of the way there after five
    // minutes, which the power alone (2026-11-18 and before) never was.
    const at300 = ticks[300].p;
    assert.ok(at300.speed > 1.025 && at300.speed < 1.04, `speed ${at300.speed}`);
    assert.ok(Math.abs(at300.deltaS - finalS) < 0.3 * Math.abs(finalS), `at 300 s ${at300.deltaS.toFixed(1)} vs ${finalS.toFixed(1)}`);
    const half = ticks[Math.floor(ticks.length / 2)];
    assert.ok(Math.abs(half.p.deltaS - finalS) < 0.12 * Math.abs(finalS), `half way (${half.t} s) ${half.p.deltaS.toFixed(1)}`);
});

test('a shorter event ends the prediction at the event distance', () => {
    const finishM = Math.round(plan.lengthM * 0.6);
    const ticks = ride({finishM, untilM: finishM});
    const first = ticks[0].p;
    assert.equal(first.finishM, finishM);
    assert.ok(first.planTotalS < plan.timeS * 0.65 && first.planTotalS > plan.timeS * 0.5, `plan to the event's end ${first.planTotalS}`);
    assert.ok(Math.abs(ticks.at(-1).p.totalS - first.planTotalS) <= 2, `finished ${ticks.at(-1).p.totalS} vs ${first.planTotalS}`);
    assert.equal(predict({tracking: createTracking(), plan, index: 0, planM: 0, raceS: 0, finishM: plan.lengthM * 2}).finishM, plan.lengthM);
});

test('the time exponent is a third on the flat and climbs with the gradient', () => {
    const flat = {powerW: 280, speedMs: 12, grade: 0};
    const climb = {powerW: 280, speedMs: 4, grade: 8};
    assert.ok(Math.abs(timeExponent(flat, 75) - 0.36) < 0.03, `flat ${timeExponent(flat, 75)}`);
    assert.ok(timeExponent(climb, 75) > 0.6, `climb ${timeExponent(climb, 75)}`);
    assert.equal(timeExponent({}, 75), 1 / 3);
});

test('the power ratio is 1 without a sample, skips the start and looks back ten minutes', () => {
    assert.equal(POWER_WINDOW_S, 600);
    const tracking = createTracking();
    assert.deepEqual(powerRatio(tracking, intervals, 0), {ratio: 1, sampleS: 0});
    tracking.stats[0] = {index: 0, startRaceS: 0, endRaceS: 100, elapsedS: 100, avgPowerW: intervals[0].powerW * 1.2, finished: true};
    tracking.stats[1] = {index: 1, startRaceS: 100, endRaceS: null, elapsedS: 50, avgPowerW: intervals[1].powerW, finished: false};
    // The first START_SKIP_S are left out: 70 s of the first interval and 50 of the second.
    const now = powerRatio(tracking, intervals, 150);
    assert.equal(now.sampleS, 150 - START_SKIP_S);
    const raw = (70 * 1.2 + 50) / 120;
    assert.ok(Math.abs(now.ratio - (1 + (raw - 1) * 120 / (120 + POWER_PRIOR_S))) < 1e-9, `ratio ${now.ratio}`);
    // Both closed long ago: nothing in the last ten minutes, so no opinion.
    tracking.stats[1] = {...tracking.stats[1], endRaceS: 150, finished: true};
    assert.deepEqual(powerRatio(tracking, intervals, 800), {ratio: 1, sampleS: 0});
    // Half the first inside the window: only that half counts.
    const half = powerRatio(tracking, intervals, 650);
    assert.equal(half.sampleS, 100);
    assert.ok(half.ratio > 1 && half.ratio < now.ratio, `half: ${JSON.stringify(half)}`);
    // The old reading (five minutes, 60 s of prior, no skip) is still there to ask for.
    assert.equal(powerRatio(tracking, intervals, 150, {windowS: 300, priorS: 60, skipS: 0}).sampleS, 150);
});

test('the speed against the plan: 1 with nothing ridden, the plan\'s time over the rider\'s', () => {
    const tracking = createTracking();
    assert.equal(speedAgainstPlan(tracking, intervals, 0, 0, plan.weightKg), 1);
    const iv = intervals[1];
    // The second interval at its power in 90 % of its time, after the start.
    tracking.stats[1] = {index: 1, startRaceS: 100, endRaceS: 100 + iv.durationS * 0.9, startPlanM: iv.startM, elapsedS: iv.durationS * 0.9, avgPowerW: iv.powerW, finished: true};
    const s = speedAgainstPlan(tracking, intervals, 100 + iv.durationS * 0.9, iv.endM, plan.weightKg, {priorS: 0});
    assert.ok(Math.abs(s - 1 / 0.9) < 1e-6, `speed ${s}`);
    // With the prior it leans on the plan.
    const shrunk = speedAgainstPlan(tracking, intervals, 100 + iv.durationS * 0.9, iv.endM, plan.weightKg);
    assert.ok(shrunk > 1 && shrunk < s);
});

test('the open interval closes at the finish, and the plan\'s pace carries on past its last metre', async () => {
    const {closeInterval, planTimeAtMetre, createTracking: ct, advance: adv} = await import('../pages/src/engine/tracking.mjs');
    const intervals = [
        {index: 0, startM: 0, endM: 100, lengthM: 100, durationS: 10, startTimeS: 0, endTimeS: 10, powerW: 200, grade: 0, speedMs: 10},
        {index: 1, startM: 100, endM: 200, lengthM: 100, durationS: 20, startTimeS: 10, endTimeS: 30, powerW: 200, grade: 0, speedMs: 5},
    ];
    const tr = ct();
    adv(tr, {index: 1, raceS: 12, power: 200, planM: 120, intervals});
    closeInterval(tr, {raceS: 35, power: 200});
    assert.equal(tr.stats[1].finished, true);
    assert.equal(tr.stats[1].endRaceS, 35);
    assert.ok(Math.abs(tr.stats[1].elapsedS - 23) < 1e-9, `ridden ${tr.stats[1].elapsedS}`);
    closeInterval(tr, {raceS: 40, power: 200});
    assert.equal(tr.stats[1].endRaceS, 35, 'closing again changes nothing');
    assert.equal(planTimeAtMetre(intervals, 200), 30);
    assert.ok(Math.abs(planTimeAtMetre(intervals, 250) - 30 - 50 / 5) < 1e-9, 'the last pace carries past the end');
    assert.equal(closeInterval(ct(), {raceS: 3}).stats.length, 0, 'nothing open: nothing closes');
});

test('a metre that jumps past intervals (a course lock) begins and closes each one jumped over, partial', () => {
    const tracking = createTracking();
    // Ride interval 0 to its end, then the metre jumps over intervals 1 and 2 to inside interval 3.
    const first = intervals[0];
    advance(tracking, {index: 0, raceS: 0, power: first.powerW, planM: first.startM + 1, intervals, atStart: true, startLineM: 0});
    advance(tracking, {index: 0, raceS: 10, power: first.powerW, planM: first.endM - 1, intervals});
    const jumpTo = intervals[3].startM + 5;
    advance(tracking, {index: 3, raceS: 11, power: intervals[3].powerW, planM: jumpTo, intervals});
    for (let j = 0; j <= 3; j++) {
        assert.ok(tracking.stats[j], `interval ${j} has stats`);
    }
    assert.equal(tracking.stats[1].partial, true, 'jumped over: partial');
    assert.equal(tracking.stats[1].finished, true);
    assert.equal(tracking.stats[1].elapsedS, 0, 'not ridden');
    assert.equal(tracking.stats[2].finished, true);
    assert.equal(tracking.stats[3].finished, false, 'the interval the rider is in is open');
    assert.equal(tracking.stats[3].partial, false, 'joined 5 m in: within the partial allowance');
});
