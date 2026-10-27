// The finish prediction (docs/REVAMP_PLAN.md 6.1): a clock offset is carried, not
// extrapolated; the rest of the race is timed from the rider's power through each
// interval's physics; a shorter event ends the prediction at its own distance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {createTracking, advance, predict, timeExponent, powerRatio, POWER_PRIOR_S} from '../pages/src/engine/tracking.mjs';

const plan = normalisePlan(JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8')));
const intervals = plan.intervals;

// Rides the plan at its own speeds, one tick a second, from the clock start at metre 0.
// clockOffsetS: seconds the race clock had already run at metre 0 (a clock from the gate
// when the timer starts later). powerScale: actual / plan power, held on every interval.
function ride({clockOffsetS = 0, powerScale = 1, untilM = plan.lengthM, onTick = null, finishM = null} = {}) {
    const tracking = createTracking();
    let planM = 0;
    let raceS = clockOffsetS;
    let t = 0;
    const out = [];
    while (planM < untilM) {
        const iv = intervals.find(x => planM >= x.startM && planM < x.endM) ?? intervals.at(-1);
        const index = intervals.indexOf(iv);
        // A few % more power on the flat gives a third of that in speed.
        const speed = iv.speedMs * Math.pow(powerScale, timeExponent(iv, plan.weightKg));
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
    const early = ticks[30].p;
    const later = ticks[600].p;
    assert.ok(early.deltaS <= 0 && early.deltaS > -12, `at 30 s: ${early.deltaS.toFixed(1)}`);
    assert.ok(later.deltaS < early.deltaS, `at 600 s: ${later.deltaS.toFixed(1)} vs ${early.deltaS.toFixed(1)}`);
    // Shrunk towards 1 until a few minutes of sample: at 30 s the ratio has a fifth of its weight.
    assert.ok(early.pacing > 1 && early.pacing < 1.025 * 30 / (30 + POWER_PRIOR_S) + 1.001, `early ratio ${early.pacing}`);
    // Five minutes of sample: the ratio carries five sixths of its weight.
    assert.ok(later.pacing > 1.018 && later.pacing < 1.025, `later ratio ${later.pacing}`);
    // The whole race at 2.5 % over on flat ground: around 0.8 % faster.
    const gain = -ticks.at(-1).p.deltaS;
    assert.ok(gain > 0.004 * plan.timeS && gain < 0.012 * plan.timeS, `finished ${gain.toFixed(1)} s ahead of ${plan.timeS}`);
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

test('the power ratio is 1 without a sample and looks back five minutes', () => {
    const tracking = createTracking();
    assert.deepEqual(powerRatio(tracking, intervals, 0), {ratio: 1, sampleS: 0});
    tracking.stats[0] = {index: 0, startRaceS: 0, endRaceS: 100, elapsedS: 100, avgPowerW: intervals[0].powerW * 1.2, finished: true};
    tracking.stats[1] = {index: 1, startRaceS: 100, endRaceS: null, elapsedS: 50, avgPowerW: intervals[1].powerW, finished: false};
    const now = powerRatio(tracking, intervals, 150);
    assert.ok(now.ratio > 1.05 && now.ratio < 1.2, `ratio ${now.ratio}`);
    assert.equal(now.sampleS, 150);
    // Both closed long ago: nothing in the last five minutes, so no opinion.
    tracking.stats[1] = {...tracking.stats[1], endRaceS: 150, finished: true};
    assert.deepEqual(powerRatio(tracking, intervals, 500), {ratio: 1, sampleS: 0});
    // Half inside the window: only that half counts.
    const half = powerRatio(tracking, intervals, 350);
    assert.equal(half.sampleS, 100);
    assert.ok(half.ratio > 1.05 && half.ratio < now.ratio, `half: ${JSON.stringify(half)}`);
});
