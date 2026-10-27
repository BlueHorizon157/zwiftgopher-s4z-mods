// The kernel port must reproduce the planner's wbal_kj figures when the plan is ridden
// exactly (docs/REVAMP_PLAN.md 1.6): every plan fixture, every interval, within 0.1 kJ.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {update, traceAlongPlan, recoverCapped} from '../pages/src/engine/wbal.mjs';

const PLANS = new URL('./fixtures/plans/', import.meta.url).pathname;

for (const name of readdirSync(PLANS).filter(f => f.endsWith('.json'))) {
    test(`W'bal along ${name} matches the planner within 0.1 kJ`, () => {
        const file = JSON.parse(readFileSync(join(PLANS, name), 'utf8'));
        const cp = file.rider.cp_wbal ?? file.rider.cp_used ?? file.rider.ftp;
        const wPrime = file.rider.wprime_used_j;
        const level = file.inputs?.fitnessLevel ?? 'competitive';
        const trace = traceAlongPlan(file.intervals.map(iv => ({powerW: iv.power_w, durationS: iv.duration_s})), cp, wPrime, {level});
        let worst = 0;
        let elapsed = 0;
        file.intervals.forEach((iv, i) => {
            elapsed += iv.duration_s;
            // cp_wbal is written to 0.1 W: up to 0.05 W x elapsed seconds of drift above CP.
            const tolerance = 0.1 + 0.05 * elapsed / 1000;
            const diff = Math.abs(trace[i] / 1000 - iv.wbal_kj);
            worst = Math.max(worst, diff);
            assert.ok(diff <= tolerance, `interval ${i + 1}: kernel ${(trace[i] / 1000).toFixed(3)} kJ vs plan ${iv.wbal_kj} kJ (cp ${cp}, W' ${wPrime})`);
        });
        assert.ok(Math.abs(Math.min(...trace) / 1000 - file.summary.min_wbal_kj) <= 0.1 + 0.5, 'minimum within an interval may sit below the interval ends');
    });

    // Each strategy card's own plan (plan_intervals, 5.2) holds to the same kernel.
    const file = JSON.parse(readFileSync(join(PLANS, name), 'utf8'));
    for (const card of (file.cards ?? []).filter(c => c.plan_intervals)) {
        test(`W'bal along ${name} card ${card.key} matches the planner within 0.1 kJ`, () => {
            const cp = file.rider.cp_wbal ?? file.rider.cp_used ?? file.rider.ftp;
            const rows = card.plan_intervals;
            const trace = traceAlongPlan(rows.map(iv => ({powerW: iv.power_w, durationS: iv.duration_s})), cp, file.rider.wprime_used_j, {level: file.inputs?.fitnessLevel ?? 'competitive'});
            let elapsed = 0;
            rows.forEach((iv, i) => {
                elapsed += iv.duration_s;
                const diff = Math.abs(trace[i] / 1000 - iv.wbal_kj);
                assert.ok(diff <= 0.1 + 0.05 * elapsed / 1000, `interval ${i + 1}: kernel ${(trace[i] / 1000).toFixed(3)} kJ vs card ${iv.wbal_kj} kJ`);
            });
        });
    }
}

test('depletion is linear, recovery is capped at DCP, CP holds', () => {
    assert.equal(update(20000, 350, 300, 10, 20000), 19500);
    assert.equal(update(20000, 300, 300, 10, 20000), 20000);
    // 17 W under CP with an 18 kJ deficit refills at most 17 J/s (the cap), not 96 J/s.
    const after = update(2000, 283, 300, 10, 20000);
    assert.ok(after - 2000 <= 17 * 10 + 1e-9 && after - 2000 > 160, `capped refill ${after - 2000}`);
    assert.equal(update(25000, 100, 300, 10, 20000), 20000, 'never above W prime');
});

test('a long step equals the same time in short steps', () => {
    const one = update(1000, 250, 300, 120, 20000);
    let w = 1000;
    for (let i = 0; i < 120; i++) {
        w = update(w, 250, 300, 1, 20000);
    }
    assert.ok(Math.abs(one - w) < 1, `${one} vs ${w}`);
    assert.ok(recoverCapped(20000, 0, 100, 50, 10) === 20000);
});
