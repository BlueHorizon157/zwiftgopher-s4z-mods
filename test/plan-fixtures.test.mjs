// The plan fixtures (docs/REVAMP_PLAN.md Phase 0.1): plan files from the planner's golden
// cases (scripts/make-plan-fixtures.php) and one pre-file share payload. These checks pin
// what the engine (Phase 1) may rely on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const PLANS = new URL('./fixtures/plans/', import.meta.url).pathname;
const LEGACY = new URL('./fixtures/legacy/', import.meta.url).pathname;
const planFiles = readdirSync(PLANS).filter(f => f.endsWith('.json'));
const legacyFiles = readdirSync(LEGACY).filter(f => f.endsWith('.json'));

test('there are plan-file fixtures', () => {
    assert.ok(planFiles.length >= 4, `expected plan fixtures in ${PLANS}, found ${planFiles.length}`);
});

for (const name of planFiles) {
    test(`plan file ${name} is a sound zg-tt-plan/1`, () => {
        const file = JSON.parse(readFileSync(join(PLANS, name), 'utf8'));
        assert.equal(file.schema, 'zg-tt-plan/1');
        assert.match(String(file.route.id), /^\d+$/, 'route id');
        assert.ok(file.rider.cp_used > 0, 'cp_used');
        assert.ok(file.rider.wprime_used_j > 0, 'wprime_used_j');
        assert.equal(file.settings.wPrime, file.rider.wprime_used_j, 'legacy settings.wPrime alias');
        assert.ok(Array.isArray(file.intervals) && file.intervals.length > 0, 'intervals');
        let elapsed = 0;
        file.intervals.forEach((iv, i) => {
            assert.ok(iv.end_m > iv.start_m, `interval ${i + 1} metres`);
            assert.ok(Math.abs(iv.start_km * 1000 - iv.start_m) < 1, `interval ${i + 1} km/m agree`);
            if (i > 0) {
                assert.ok(Math.abs(iv.start_m - file.intervals[i - 1].end_m) < 0.2, `interval ${i + 1} contiguous`);
            } else {
                assert.ok(Math.abs(iv.start_m) < 0.2, 'the first interval starts at metre 0');
            }
            assert.ok(Number.isFinite(iv.power_w) && iv.power_w >= 0, `interval ${i + 1} power`);
            assert.ok(iv.duration_s > 0, `interval ${i + 1} duration`);
            assert.ok(Math.abs(iv.start_time_s - elapsed) < 0.6, `interval ${i + 1} start_time_s is cumulative`);
            assert.match(iv.duration_text, /^\d+:\d\d(:\d\d)?$/, `interval ${i + 1} duration_text`);
            assert.ok(Number.isFinite(iv.wbal_kj), `interval ${i + 1} wbal_kj`);
            elapsed += iv.duration_s;
        });
        const n = file.intervals.length;
        assert.ok(Math.abs(file.summary.time_seconds - elapsed) <= n + 1,
            `durations sum (${elapsed}) within ${n + 1} s of summary.time_seconds (${file.summary.time_seconds})`);
        const lastEnd = file.intervals[n - 1].end_m;
        // summary.distance_km is rounded to 10 m: the engine must use end_m, not it.
        assert.ok(Math.abs(file.summary.distance_km * 1000 - lastEnd) <= 5, 'summary.distance_km is the last end to 10 m');
    });
}

for (const name of legacyFiles) {
    test(`legacy payload ${name} has the fields mods up to 0.6.4 read`, () => {
        const plan = JSON.parse(readFileSync(join(LEGACY, name), 'utf8'));
        assert.equal(plan.schema, undefined, 'no schema field');
        assert.ok(plan.intervals.length > 0);
        for (const iv of plan.intervals) {
            for (const k of ['start_km', 'end_km', 'power_w', 'avg_gradient', 'duration_text', 'duration_s', 'wbal_kj']) {
                assert.ok(k in iv, `interval has ${k}`);
            }
        }
        assert.ok(plan.summary.distance_km > 0);
        assert.ok(typeof plan.route.name === 'string');
        assert.ok(plan.rider.ftp > 0);
        assert.ok(plan.settings.wPrime > 0);
    });
}
