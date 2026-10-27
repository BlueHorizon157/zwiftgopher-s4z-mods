import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalisePlan, parseDurationText, formatDuration} from '../pages/src/engine/plan.mjs';
import {locate, boundary, BEFORE} from '../pages/src/engine/cursor.mjs';

const file = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy/flat.fit.optimise.json', import.meta.url), 'utf8'));

test('a plan file normalises to metres, seconds and the W\'bal CP', () => {
    const plan = normalisePlan(file, {code: 'ABC123'});
    assert.equal(plan.source, 'file');
    assert.equal(plan.code, 'ABC123');
    assert.equal(plan.routeId, file.route.id);
    assert.equal(plan.lengthM, file.intervals.at(-1).end_m);
    assert.equal(plan.cp, file.rider.cp_wbal);
    assert.equal(plan.cpUsed, file.rider.cp_used);
    assert.equal(plan.wPrimeJ, file.rider.wprime_used_j);
    assert.equal(plan.intervals.length, file.intervals.length);
    assert.equal(plan.intervals[0].startM, 0);
    assert.ok(Math.abs(plan.timeS - file.summary.time_seconds) < 0.01);
    assert.equal(plan.intervals[1].startTimeS, file.intervals[1].start_time_s);
    assert.ok(plan.peakPowerW > plan.avgPowerW);
    assert.match(plan.signature, /^\d+\|\d+\|[0-9a-z]+$/);
});

test('a legacy share payload normalises to the same shape', () => {
    const plan = normalisePlan(legacy);
    const fromFile = normalisePlan(file);
    assert.equal(plan.source, 'legacy');
    assert.equal(plan.lengthM, fromFile.lengthM);
    assert.equal(plan.cp, legacy.rider.cp_wbal ?? legacy.rider.cp_used ?? legacy.rider.ftp);
    assert.equal(plan.wPrimeJ, legacy.settings.wPrime);
    plan.intervals.forEach((iv, i) => {
        assert.ok(Math.abs(iv.startM - fromFile.intervals[i].startM) < 1, `interval ${i + 1} start`);
        assert.equal(iv.powerW, fromFile.intervals[i].powerW);
    });
    assert.equal(plan.signature, fromFile.signature, 'the same plan in both shapes has one signature');
});

test('a strategy card rides its own plan; the shared plan stays the default (5.2)', () => {
    const shared = normalisePlan(file, {code: 'ABC123'});
    const sharedCard = shared.cards.find(c => c.isShared);
    assert.equal(sharedCard?.key, 'fastest', 'the optimised plan is its fastest card');
    assert.equal(shared.card, null);
    assert.equal(shared.strategy, 'fastest');
    assert.ok(shared.cards.every(c => c.switchable), 'every card carries plan_intervals');
    assert.deepEqual(shared.cards.filter(c => c.selected).map(c => c.key), ['fastest']);

    const balanced = normalisePlan(file, {code: 'ABC123', card: 'balanced'});
    const card = file.cards.find(c => c.key === 'balanced');
    assert.equal(balanced.card, 'balanced');
    assert.equal(balanced.strategy, 'balanced');
    assert.equal(balanced.strategyLabel, 'Balanced');
    assert.equal(balanced.intervals.length, card.plan_intervals.length);
    assert.ok(Math.abs(balanced.timeS - card.time_seconds) < 0.2, `${balanced.timeS} vs ${card.time_seconds}`);
    assert.equal(balanced.lengthM, shared.lengthM);
    assert.equal(balanced.avgPowerW, card.avg_power_w);
    assert.equal(balanced.timeText, card.time_text);
    assert.equal(balanced.sharedTimeText, file.summary.time_text);
    assert.equal(balanced.cp, shared.cp, 'the rider is the same');
    assert.notEqual(balanced.signature, shared.signature, 'a new plan for the engine');
    assert.deepEqual(balanced.cards.filter(c => c.selected).map(c => c.key), ['balanced']);

    // Choosing the card the plan already is changes nothing the engine sees.
    assert.equal(normalisePlan(file, {card: 'fastest'}).signature, shared.signature);
    // An unknown card, or a share made before the cards carried their plans: the plan as shared.
    assert.equal(normalisePlan(file, {card: 'nonsense'}).signature, shared.signature);
    const old = structuredClone(file);
    for (const c of old.cards) {
        delete c.plan_intervals;
    }
    const oldPlan = normalisePlan(old, {card: 'balanced'});
    assert.equal(oldPlan.signature, shared.signature);
    assert.ok(oldPlan.cards.every(c => !c.switchable));
    assert.equal(normalisePlan(legacy, {card: 'balanced'}).card, null);
});

test('a margin plan\'s cards carry W\' on the rider\'s own numbers', () => {
    const margin = JSON.parse(readFileSync(new URL('./fixtures/plans/rollers.fit.margin5.optimise.json', import.meta.url), 'utf8'));
    const safe = normalisePlan(margin, {card: 'safe_finish'});
    const card = margin.cards.find(c => c.key === 'safe_finish');
    assert.equal(safe.minWbalKj, card.min_wbal_rider_kj);
    assert.ok(safe.intervals.every(iv => iv.wbalMarginKj != null && iv.wbalKj >= iv.wbalMarginKj));
});

test('normalisePlan rejects what is not a plan', () => {
    assert.equal(normalisePlan(null), null);
    assert.equal(normalisePlan({intervals: []}), null);
    assert.equal(normalisePlan({schema: 'zg-tt-plan/1'}), null);
});

test('durations parse and format as the planner writes them', () => {
    assert.equal(parseDurationText('4:58'), 298);
    assert.equal(parseDurationText('1:02:43'), 3763);
    assert.equal(parseDurationText('nope'), null);
    assert.equal(formatDuration(299.9), '4:59');
    assert.equal(formatDuration(3763), '1:02:43');
});

test('locate finds the interval with or without a hint, before and past the plan', () => {
    const {intervals} = normalisePlan(file);
    assert.equal(locate(intervals, -5), BEFORE);
    assert.equal(locate(intervals, 0), 0);
    assert.equal(locate(intervals, intervals[0].endM - 0.01), 0);
    assert.equal(locate(intervals, intervals[0].endM), 1);
    assert.equal(locate(intervals, intervals.at(-1).endM), intervals.length);
    for (let m = 0; m < intervals.at(-1).endM; m += 37) {
        const expect = intervals.findIndex(iv => m >= iv.startM && m < iv.endM);
        assert.equal(locate(intervals, m), expect, `at ${m}`);
        assert.equal(locate(intervals, m, Math.max(0, expect - 1)), expect, `at ${m} with hint`);
        assert.equal(locate(intervals, m, 7), expect, `at ${m} with a wrong hint`);
    }
});

test('boundary gives metres to the next change and progress', () => {
    const {intervals} = normalisePlan(file);
    const b = boundary(intervals, 0, intervals[0].endM - 100);
    assert.equal(b.nextIndex, 1);
    assert.ok(Math.abs(b.toNextM - 100) < 1e-9);
    assert.ok(b.progress > 0.9 && b.progress < 1);
    assert.equal(boundary(intervals, intervals.length, 99999).progress, 1);
    assert.equal(boundary(intervals, intervals.length - 1, intervals.at(-1).startM).nextIndex, null);
});
