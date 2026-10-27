// The field model (pages/src/engine/field.mjs) on the synthetic recording's six rivals:
// each rides the plan's speeds times a known factor, released a known number of seconds
// from the home rider, so the gaps, trends and sector speeds have expected values.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonl} from '../pages/src/replay.mjs';
import {createField, ingest, rows, rivals, lastSector, resetField, FIELD_DEFAULTS} from '../pages/src/engine/field.mjs';

const recording = parseJsonl(readFileSync(new URL('./fixtures/telemetry/synthetic-flat-tt.jsonl', import.meta.url), 'utf8'));
const plan = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
const meta = recording[0].d;
const EPOCH = meta.startedAt;
const nearby = recording.filter(r => r.ch === 'nearby');
const boundaries = [0, ...plan.intervals.map(iv => iv.end_m)];
// From scripts/make-synthetic-telemetry.mjs.
const RIVALS = {
    'Lena Fischer': {releaseS: -20, factor: 0.985},
    'Tom Okafor': {releaseS: -10, factor: 1.012},
    'Ana Ribeiro': {releaseS: -5, factor: 0.995},
    'Sam Patel': {releaseS: 5, factor: 1.02},
    'Mia Kowalski': {releaseS: 10, factor: 0.97},
    'Joe Hart': {releaseS: 25, factor: 1.0},
};

function playTo(seconds, ctx = {lineM: 180, kind: 'tt'}, field = createField()) {
    for (const row of nearby) {
        if (row.t > seconds * 1000) {
            break;
        }
        ingest(field, row.d, EPOCH + row.t, ctx);
    }
    return field;
}

test('the recording carries the rivals as nearby rows with the home rider watching', () => {
    assert.ok(nearby.length > 400);
    assert.equal(nearby[0].d.length, 7);
    assert.equal(nearby[0].d.filter(e => e.watching).length, 1);
    assert.match(meta.assumptions.E_rivals, /6 made-up riders/);
});

test('every rider is followed from the line, home is the watching rider', () => {
    const f = playTo(400);
    assert.equal(f.riders.size, 7);
    assert.equal(f.riders.get(f.homeId).name, 'Synthetic Rider');
    for (const r of f.riders.values()) {
        assert.equal(r.startSource, 'line', `${r.name} start seen at the line`);
        assert.ok(r.lastK > 50, `${r.name} has checkpoints`);
    }
});

test('road and clock gaps follow the start offsets and the speed factors', () => {
    const t = 600;
    const f = playTo(t);
    const list = rows(f, {nowMs: EPOCH + t * 1000, boundaries});
    const byName = Object.fromEntries(list.map(r => [r.name, r]));
    assert.equal(byName['Synthetic Rider'].isHome, true);
    // Same speed, released 25 s later: 25 s behind on the road, level on the clock.
    assert.ok(Math.abs(byName['Joe Hart'].roadS + 25) < 0.3, `Joe road ${byName['Joe Hart'].roadS}`);
    assert.ok(Math.abs(byName['Joe Hart'].clockS) < 0.3, `Joe clock ${byName['Joe Hart'].clockS}`);
    for (const [name, rv] of Object.entries(RIVALS)) {
        const r = byName[name];
        // The clock gap is the road gap less the start offset (released earlier: ahead on the road).
        assert.ok(Math.abs(r.clockS - (r.roadS + rv.releaseS)) < 0.5, `${name}: clock ${r.clockS} road ${r.roadS}`);
        // Faster riders are ahead on the clock, slower ones behind.
        if (rv.factor > 1) {
            assert.ok(r.clockS > 1, `${name} faster on the clock`);
        } else if (rv.factor < 1) {
            assert.ok(r.clockS < -0.5, `${name} slower on the clock`);
        }
    }
});

test('the trend says who home gains and loses time on, near the expected rate', () => {
    const t = 900;
    const f = playTo(t);
    const byName = Object.fromEntries(rows(f, {nowMs: EPOCH + t * 1000, boundaries}).map(r => [r.name, r]));
    for (const [name, rv] of Object.entries(RIVALS)) {
        const r = byName[name];
        const expected = 60 * (1 / rv.factor - 1);      // s/min home gains on this rider
        assert.ok(Math.abs(r.gainSPerMin - expected) < 0.3, `${name}: ${r.gainSPerMin} vs ${expected}`);
        const word = Math.abs(expected) < FIELD_DEFAULTS.holdSPerMin ? 'holding' : expected > 0 ? 'gaining' : 'losing';
        assert.equal(r.trend, word, name);
        assert.ok(r.trendSpanS >= 60 && r.trendSpanS < 70, `${name} window ${r.trendSpanS}`);
    }
});

test('sector speeds are over the last complete plan sector, in the riders\' ratio', () => {
    const t = 900;
    const f = playTo(t);
    for (const r of rows(f, {nowMs: EPOCH + t * 1000, boundaries})) {
        if (r.isHome) {
            continue;
        }
        const s = r.sector;
        assert.ok(s && s.endM - s.startM >= FIELD_DEFAULTS.minSectorM, `${r.name} sector ${JSON.stringify(s)}`);
        assert.ok(boundaries.includes(s.endM), `${r.name} sector ends on a plan boundary`);
        const ratio = s.riderKmh / s.homeKmh;
        assert.ok(Math.abs(ratio - RIVALS[r.name].factor) < 0.006, `${r.name}: ${ratio}`);
    }
});

test('without a plan, sectors are whole kilometres', () => {
    const t = 500;
    const f = playTo(t);
    const r = rows(f, {nowMs: EPOCH + t * 1000}).find(x => x.name === 'Mia Kowalski');
    assert.equal(r.sector.endM % 1000, 0);
    assert.equal(r.sector.endM - Math.max(r.sector.startM, 50) <= 1000, true);
});

test('lastSector merges short plan intervals backwards', () => {
    assert.deepEqual(lastSector([0, 3654, 3873, 6810], 4000, 400), {startM: 0, endM: 3873});
    assert.deepEqual(lastSector([0, 3654, 3873, 6810], 7000, 400), {startM: 3873, endM: 6810});
    assert.equal(lastSector([0, 3654], 100, 400), null);
});

test('rows sort the field by the clock gap, riders ahead first; road mode by the road', () => {
    const t = 600;
    const f = playTo(t);
    const clock = rows(f, {nowMs: EPOCH + t * 1000, boundaries}).map(r => r.name);
    assert.deepEqual(clock.slice(0, 2), ['Sam Patel', 'Tom Okafor']);
    assert.equal(clock.at(-1), 'Mia Kowalski');
    const road = rows(f, {nowMs: EPOCH + t * 1000, boundaries, gapMode: 'road'});
    const roadNames = road.map(r => r.name);
    assert.ok(roadNames.indexOf('Lena Fischer') < roadNames.indexOf('Synthetic Rider'));
    assert.ok(roadNames.indexOf('Joe Hart') > roadNames.indexOf('Synthetic Rider'));
    for (let i = 1; i < road.length; i++) {
        assert.ok(road[i - 1].gapS >= road[i].gapS, 'sorted by road gap');
    }
});

test('rivals: the nearest ahead and behind on the road', () => {
    const t = 600;
    const f = playTo(t);
    const rv = rivals(f, {nowMs: EPOCH + t * 1000, boundaries, each: 2});
    assert.equal(rv.home.name, 'Synthetic Rider');
    assert.equal(rv.ahead.length, 2);
    assert.equal(rv.behind.length, 2);
    assert.ok(rv.ahead[0].roadS > 0 && rv.ahead[0].roadS <= rv.ahead[1].roadS);
    assert.ok(rv.behind[0].roadS <= 0 && rv.behind[0].roadS >= rv.behind[1].roadS);
    assert.equal(rv.all.length, 6);
});

test('a group event runs every clock from the gun: clock gap = road gap', () => {
    const f = playTo(400, {kind: 'group', gunMs: EPOCH + 30_000});
    for (const r of rows(f, {nowMs: EPOCH + 400_000, boundaries})) {
        if (!r.isHome) {
            assert.equal(r.clockS, r.roadS, r.name);
        }
    }
});

test('riders unseen for 2 min fade, after 10 min they go; home stays', () => {
    const f = playTo(300);
    const last = nearby.find(r => r.t >= 300_000);
    const homeOnly = last.d.filter(e => e.watching);
    ingest(f, homeOnly, EPOCH + 300_000 + 3 * 60_000, {lineM: 180, kind: 'tt'});
    const faded = rows(f, {nowMs: EPOCH + 300_000 + 3 * 60_000});
    assert.equal(faded.filter(r => r.stale).length, 6);
    ingest(f, homeOnly, EPOCH + 300_000 + 11 * 60_000, {lineM: 180, kind: 'tt'});
    assert.equal(f.riders.size, 1);
    assert.equal([...f.riders.values()][0].name, 'Synthetic Rider');
});

test('a distance that goes back (a new event) clears the rider\'s checkpoints; reset clears all', () => {
    const f = playTo(300);
    const homeEntry = structuredClone(nearby.find(r => r.t >= 300_000).d.find(e => e.watching));
    homeEntry.state.eventDistance = 10;
    ingest(f, [homeEntry], EPOCH + 302_000, {lineM: 180, kind: 'tt'});
    const home = f.riders.get(f.homeId);
    assert.equal(home.lastK, 0);
    assert.equal(home.startWT, null);
    resetField(f);
    assert.equal(f.riders.size, 0);
});

test('another category is left out unless all riders are asked for', () => {
    const f = playTo(200);
    const stranger = structuredClone(nearby.find(r => r.t >= 200_000).d.find(e => !e.watching));
    stranger.athleteId = 123;
    stranger.athlete.id = 123;
    stranger.state.eventSubgroupId = 999;
    ingest(f, [stranger], EPOCH + 200_500, {lineM: 180, kind: 'tt'});
    assert.equal(rows(f, {nowMs: EPOCH + 200_500}).length, 7);
    assert.equal(rows(f, {nowMs: EPOCH + 200_500, allSubgroups: true}).length, 8);
});

test('at the finish every rider has a sector speed, to the line they stopped on', () => {
    const t = 945;
    const f = playTo(t);
    for (const r of rows(f, {nowMs: EPOCH + t * 1000, boundaries})) {
        if (r.isHome || r.distanceM < plan.intervals.at(-1).end_m) {
            continue;
        }
        assert.ok(Number.isFinite(r.sector?.riderKmh) && Number.isFinite(r.sector?.homeKmh), `${r.name}: ${JSON.stringify(r.sector)}`);
        assert.ok(Math.abs(r.sector.riderKmh / r.sector.homeKmh - RIVALS[r.name].factor) < 0.006, r.name);
    }
});
