// The field model (pages/src/engine/field-model.mjs), on the clock. Two kinds of test: the
// synthetic recording's six rivals (each rides the plan's speeds times a known factor, released a
// known number of seconds from the home rider), and small riders built here, for the cases the
// synthetic recording does not have: a staggered start, riders not yet comparable, a rider who
// has finished, the home rider leaving the event, the settings that moved on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJsonl} from '../pages/src/replay.mjs';
import {
    createField, ingest, rows, rivals, lastSector, resetField, placeOf, finishRaceOf, drift,
    FIELD_DEFAULTS, migrateFieldPrefs, trackRangeOf, gapModeOf,
} from '../pages/src/engine/field-model.mjs';

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

function playTo(seconds, ctx = {lineM: 0, kind: 'tt'}, field = createField()) {
    for (const row of nearby) {
        if (row.t > seconds * 1000) {
            break;
        }
        ingest(field, row.d, EPOCH + row.t, ctx);
    }
    return field;
}

/** A nearby entry for a rider who started at startS (world seconds) and rides at speedMs from then. */
function entry(id, {startS = 0, speedMs = 10, subgroup = 9, watching = false, name = null, t = 0, distanceM = null} = {}) {
    const dist = distanceM ?? (t > startS ? speedMs * (t - startS) : 0);
    return {
        athleteId: id, watching, athlete: {sanitizedFullname: name ?? `Rider ${id}`, weight: 70, wPrime: 20000},
        state: {
            eventDistance: dist, worldTime: EPOCH + t * 1000, time: dist > 0 ? Math.floor(t - startS) : 0,
            speed: speedMs * 3.6, power: 250, eventSubgroupId: subgroup,
        },
        stats: {speed: {avg: speedMs * 3.6}, power: {avg: 250}},
    };
}

/** Feeds riders' samples every second from 0 to seconds, as Sauce's nearby list gives them. */
function simulate(field, riders, seconds, ctx = {lineM: 0, kind: 'tt', gunMs: null}, from = 0) {
    for (let t = from; t <= seconds; t++) {
        ingest(field, riders.map(rd => entry(rd.id, {...rd, t})), EPOCH + t * 1000, ctx);
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
        assert.equal(r.startSource, 'time', `${r.name} start from the game's timer`);
        assert.ok(r.lastK > 50, `${r.name} has checkpoints`);
    }
});

test('clock gaps follow the start offsets and the speed factors', () => {
    const t = 600;
    const f = playTo(t);
    const list = rows(f, {nowMs: EPOCH + t * 1000, boundaries});
    const byName = Object.fromEntries(list.map(r => [r.name, r]));
    assert.equal(byName['Synthetic Rider'].isHome, true);
    // Same speed, released 25 s later: level on the clock.
    assert.ok(Math.abs(byName['Joe Hart'].clockS) < 0.3, `Joe clock ${byName['Joe Hart'].clockS}`);
    for (const [name, rv] of Object.entries(RIVALS)) {
        const r = byName[name];
        // Faster riders are ahead on the clock, slower ones behind.
        if (rv.factor > 1) {
            assert.ok(r.clockS > 1, `${name} faster on the clock: ${r.clockS}`);
        } else if (rv.factor < 1) {
            assert.ok(r.clockS < -0.5, `${name} slower on the clock: ${r.clockS}`);
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

test('rows are in clock order, each with its like-for-like place (1 furthest ahead on the clock)', () => {
    const t = 600;
    const f = playTo(t);
    const list = rows(f, {nowMs: EPOCH + t * 1000, boundaries});
    assert.deepEqual(list.slice(0, 2).map(r => r.name), ['Sam Patel', 'Tom Okafor']);
    assert.equal(list.at(-1).name, 'Mia Kowalski');
    for (let i = 1; i < list.length; i++) {
        assert.ok(list[i - 1].gapS >= list[i].gapS, 'sorted by the clock gap');
    }
    assert.deepEqual(list.map(r => r.place), [1, 2, 3, 4, 5, 6, 7], 'places 1 to 7, home included');
    const home = list.findIndex(r => r.isHome) + 1;
    assert.deepEqual(placeOf(list), {place: home, of: 7}, 'your place is your row\'s place');
    assert.equal(home, 3, 'two riders ahead of you on the clock at 600 s');
});

test('rivals: the nearest ahead and behind on the clock', () => {
    const t = 600;
    const f = playTo(t);
    const rv = rivals(f, {nowMs: EPOCH + t * 1000, boundaries, each: 2});
    assert.equal(rv.home.name, 'Synthetic Rider');
    assert.equal(rv.ahead.length, 2);
    assert.equal(rv.behind.length, 2);
    assert.ok(rv.ahead[0].gapS > 0 && rv.ahead[0].gapS <= rv.ahead[1].gapS);
    assert.ok(rv.behind[0].gapS <= 0 && rv.behind[0].gapS >= rv.behind[1].gapS);
    assert.equal(rv.all.length, 6);
});

test('a group event runs every clock from the gun: each rider has a clock gap to home', () => {
    const f = playTo(400, {kind: 'group', gunMs: EPOCH + 30_000});
    for (const r of rows(f, {nowMs: EPOCH + 400_000, boundaries})) {
        if (!r.isHome) {
            assert.ok(Number.isFinite(r.clockS), r.name);
        }
    }
});

test('riders unseen for 2 min are not compared and do not count; after 10 min they go; home stays', () => {
    const f = playTo(300);
    const last = nearby.find(r => r.t >= 300_000);
    const homeOnly = last.d.filter(e => e.watching);
    ingest(f, homeOnly, EPOCH + 300_000 + 3 * 60_000, {lineM: 0, kind: 'tt'});
    const nowMs = EPOCH + 300_000 + 3 * 60_000;
    const faded = rows(f, {nowMs});
    assert.equal(faded.filter(r => r.stale).length, 6);
    for (const r of faded.filter(x => !x.isHome)) {
        assert.equal(r.comparable, false, r.name);
        assert.equal(r.reason, 'not seen for two minutes', r.name);
    }
    assert.deepEqual(placeOf(faded), {place: 1, of: 1}, 'nobody counts but you');
    ingest(f, homeOnly, EPOCH + 300_000 + 11 * 60_000, {lineM: 0, kind: 'tt'});
    assert.equal(f.riders.size, 1);
    assert.equal([...f.riders.values()][0].name, 'Synthetic Rider');
});

test('a distance that goes back (a new event) clears the rider\'s checkpoints; reset clears all', () => {
    const f = playTo(300);
    const homeEntry = structuredClone(nearby.find(r => r.t >= 300_000).d.find(e => e.watching));
    homeEntry.state.eventDistance = 10;
    homeEntry.state.time = 0;           // a new event: the game's clock goes back with its distance
    ingest(f, [homeEntry], EPOCH + 302_000, {lineM: 0, kind: 'tt'});
    const home = f.riders.get(f.homeId);
    assert.equal(home.lastK, 0);
    // Its start is the new event's: 10 m past the line at race time 0, so within the last second.
    const wt = homeEntry.state.worldTime;
    assert.ok(home.startWT <= wt && home.startWT > wt - 1000, `new start ${wt - home.startWT} ms before the sample`);
    resetField(f);
    assert.equal(f.riders.size, 0);
});

test('another category is left out unless all riders are asked for', () => {
    const f = playTo(200);
    const stranger = structuredClone(nearby.find(r => r.t >= 200_000).d.find(e => !e.watching));
    stranger.athleteId = 123;
    stranger.athlete.id = 123;
    stranger.state.eventSubgroupId = 999;
    ingest(f, [stranger], EPOCH + 200_500, {lineM: 0, kind: 'tt'});
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

test('a rider who leaves the pen is started from the game\'s timer; with no timer, from the line', () => {
    const base = structuredClone(nearby[0].d.find(e => !e.watching));
    const timed = createField();
    const at = (f, m, s, time) => {
        const e = structuredClone(base);
        Object.assign(e.state, {eventDistance: m, worldTime: EPOCH + s * 1000, speed: m > 0 ? 30 : 0});
        if (time !== undefined) {
            e.state.time = time;
        } else {
            delete e.state.time;
        }
        ingest(f, [e], EPOCH + s * 1000, {lineM: 0, kind: 'tt'});
    };
    at(timed, 0, 0, 0);
    at(timed, 0, 2, 0);
    assert.equal(timed.riders.get(String(base.athleteId)).startWT, null, 'waiting in the pen');
    at(timed, 16, 4, 1);
    const r = timed.riders.get(String(base.athleteId));
    assert.equal(r.startSource, 'time');
    assert.ok(r.startWT >= EPOCH + 2000 && r.startWT <= EPOCH + 3000, 'between the last pen sample and one second after the first moving one');

    const untimed = createField();
    at(untimed, 0, 0);
    at(untimed, 0, 2);
    at(untimed, 16, 4);
    const u = untimed.riders.get(String(base.athleteId));
    assert.equal(u.startSource, 'line');
    assert.equal(u.startWT, EPOCH + 2000, 'the last stationary sample');
});

test('a rider who rides at 0 m is not started; one with no shared point yet is not compared', () => {
    const f = createField();
    simulate(f, [{id: 1, startS: 0, speedMs: 10, watching: true, name: 'Home'}], 60);
    // A rider in the pen, and a rider who first shows up well ahead of you.
    // Pen: still at the line. Late: first seen 600 m up the road, with no checkpoints of its own yet.
    ingest(f, [entry(2, {t: 60, distanceM: 0, name: 'Pen'}), entry(3, {t: 60, startS: 10, speedMs: 12, name: 'Late', distanceM: 600})], EPOCH + 60_000, {lineM: 0, kind: 'tt'});
    const list = rows(f, {nowMs: EPOCH + 60_000});
    const pen = list.find(r => r.id === '2');
    const late = list.find(r => r.id === '3');
    assert.equal(pen.comparable, false);
    assert.equal(pen.reason, 'not started');
    assert.equal(late.comparable, false);
    assert.equal(late.reason, 'no shared point yet');
    assert.equal(pen.place, null);
    assert.ok(list.findIndex(r => r.comparable) < list.indexOf(pen), 'comparable riders come first');
});

test('a staggered start: a rider behind on the road but ahead on the clock is ahead, and no road figure is kept', () => {
    // Home rides 12 m/s from the line; the rival starts 40 s later at 13 m/s. At 250 s home is at
    // 3000 m and the rival at 2730 m: on the road the rival is 20 s behind, on the clock 17 s ahead.
    const f = simulate(createField(), [
        {id: 1, startS: 0, speedMs: 12, watching: true, name: 'Home'},
        {id: 2, startS: 40, speedMs: 13, name: 'Rival'},
    ], 250);
    const list = rows(f, {nowMs: EPOCH + 250_000});
    const rival = list.find(r => r.name === 'Rival');
    assert.ok(rival.clockS > 15 && rival.clockS < 19, `clock ${rival.clockS}`);
    const rv = rivals(f, {nowMs: EPOCH + 250_000, each: 2});
    assert.deepEqual(rv.ahead.map(r => r.name), ['Rival'], 'named ahead');
    // The road, for the test only: the rival's world time at 2700 m against home's at the same point.
    const homeAt = f.riders.get('1');
    const rivalAt = f.riders.get('2');
    const roadS = (homeAt.cp[54] - rivalAt.cp[54]) / 1000;
    assert.ok(roadS < -15, `on the road the rival is behind: ${roadS}`);
    for (const r of list) {
        for (const key of Object.keys(r)) {
            assert.equal(/road/i.test(key), false, `no road figure in the rows: ${key}`);
        }
    }
});

test('the home rider leaving the event (subgroup 0) keeps the category and the home track', () => {
    const f = simulate(createField(), [
        {id: 1, startS: 0, speedMs: 10, watching: true, name: 'Home'},
        {id: 2, startS: 5, speedMs: 11, name: 'Rival'},
    ], 200);
    const before = rows(f, {nowMs: EPOCH + 200_000});
    const homeK = f.riders.get('1').lastK;
    const homeStart = f.riders.get('1').startWT;
    // Home has stopped past the finish: its subgroup reads 0, and it keeps riding.
    const left = [entry(1, {startS: 0, speedMs: 10, watching: true, name: 'Home', t: 201, subgroup: 0}), entry(2, {startS: 5, speedMs: 11, name: 'Rival', t: 201})];
    ingest(f, left, EPOCH + 201_000, {lineM: 0, kind: 'tt'});
    assert.equal(f.subgroupId, 9, 'the category is kept');
    assert.ok(f.riders.get('1').lastK >= homeK, 'home track kept');
    assert.equal(f.riders.get('1').startWT, homeStart, 'home start kept');
    const after = rows(f, {nowMs: EPOCH + 201_000});
    assert.equal(after.length, before.length, 'the same riders in the list');
    assert.ok(after.find(r => r.isHome).comparable, 'home still compared');
});

test('a rider who passes the line is finished: frozen at the line, later riding ignored, places in finishing order', () => {
    // A 1 km race: home rides 10 m/s (through the line at 100 s), a rival 8 m/s (at 125 s).
    const ctx = {lineM: 0, kind: 'tt', gunMs: null, lengthM: 1000};
    const f = createField();
    simulate(f, [
        {id: 1, startS: 0, speedMs: 10, watching: true, name: 'Home'},
        {id: 2, startS: 0, speedMs: 8, name: 'Rival'},
    ], 200, ctx);
    const home = f.riders.get('1');
    const rival = f.riders.get('2');
    assert.equal(f.lengthM, 1000);
    assert.equal(home.finished, true);
    // The start is known to the second (the game's timer is whole seconds): within half a second.
    assert.ok(Math.abs(finishRaceOf(home) - 100) < 0.6, `home ${finishRaceOf(home)}`);
    assert.ok(Math.abs(finishRaceOf(rival) - 125) < 0.6, `rival ${finishRaceOf(rival)}`);
    assert.equal(home.lastK, 20, 'checkpoints stop at the line');
    assert.equal(rival.lastK, 20);
    const list = rows(f, {nowMs: EPOCH + 200_000});
    const r = list.find(x => x.name === 'Rival');
    const me = list.find(x => x.isHome);
    assert.equal(r.finished, true);
    assert.equal(me.finishPlace, 1);
    assert.equal(r.finishPlace, 2);
    assert.equal(r.finishers, 2);
    assert.ok(Math.abs(r.clockS + 25) < 1.2, `both finished: the clock gap is the finish gap (behind you by about 25 s), ${r.clockS}`);
    // Still riding past the line: the finish time does not change, nor the gap.
    simulate(f, [{id: 1, startS: 0, speedMs: 10, watching: true, name: 'Home'}, {id: 2, startS: 0, speedMs: 8, name: 'Rival'}], 260, ctx, 201);
    assert.equal(finishRaceOf(rival), r.finishRaceS, 'frozen');
    assert.equal(rows(f, {nowMs: EPOCH + 260_000}).find(x => x.name === 'Rival').clockS, r.clockS);
    assert.equal(r.trend, null, 'no trend once finished (the row is shown without one)');
    assert.equal(drift({paceSPerMin: null, trend: null}), null);
});

test('a rider who passed the line far before you first see them: finished, with no time', () => {
    const f = createField();
    f.lengthM = null;
    ingest(f, [entry(1, {watching: true, t: 0, speedMs: 10}), entry(2, {t: 0, speedMs: 10})], EPOCH, {lineM: 0, kind: 'tt', lengthM: 1000});
    ingest(f, [entry(2, {t: 500, speedMs: 10, distanceM: 4000}), entry(1, {t: 500, speedMs: 10, watching: true})], EPOCH + 500_000, {lineM: 0, kind: 'tt', lengthM: 1000});
    const r = f.riders.get('2');
    assert.equal(r.finished, true);
    assert.equal(finishRaceOf(r), null, 'no time seen, none made up');
});

test('the event length is the first one seen for its category; a length from after the home rider left is not taken', () => {
    const f = createField();
    ingest(f, [entry(1, {watching: true, t: 0, speedMs: 10}), entry(2, {t: 0, speedMs: 10})], EPOCH, {lineM: 0, kind: 'tt', lengthM: 21155});
    assert.equal(f.lengthM, 21155);
    // The home rider leaves the event and the game reports another length for the ride on.
    ingest(f, [entry(1, {watching: true, t: 1, speedMs: 10, subgroup: 0}), entry(2, {t: 1, speedMs: 10})], EPOCH + 1000, {lineM: 0, kind: 'tt', lengthM: 19075});
    assert.equal(f.lengthM, 21155, 'kept');
    // A new event (another category) has its own length.
    ingest(f, [entry(5, {watching: true, t: 2, speedMs: 10, subgroup: 77})], EPOCH + 2000, {lineM: 0, kind: 'tt', lengthM: 9000});
    assert.equal(f.lengthM, 9000, 'the new event\'s length');
});

test('home leaving: the rows keep the category with no road figure; reset clears the length', () => {
    const f = createField();
    ingest(f, [entry(1, {watching: true, t: 0, speedMs: 10})], EPOCH, {lineM: 0, kind: 'tt', lengthM: 500});
    resetField(f);
    assert.equal(f.lengthM, null);
});

test('the settings that moved on: a road gap is now the gap on the clock, the play range is one minute', () => {
    assert.deepEqual(migrateFieldPrefs({gapMode: 'road'}), {gapMode: 'clock'});
    assert.deepEqual(migrateFieldPrefs({rivalsRange: 'play'}), {rivalsRange: '60'});
    assert.deepEqual(migrateFieldPrefs({gapMode: 'finish', rivalsRange: '120'}), {}, 'current values stay');
    assert.deepEqual(migrateFieldPrefs({}), {}, 'nothing saved, nothing to change');
    assert.equal(trackRangeOf('play'), '60');
    assert.equal(trackRangeOf('300'), '300');
    assert.equal(trackRangeOf(undefined), '60');
    assert.equal(gapModeOf('road'), 'clock');
    assert.equal(gapModeOf('finish'), 'finish');
});

// A 1 km race: home rides 5 m/s (the line at 100 s... finish at 200 s), rider 3 at 6 m/s, rider 2 at
// 10 m/s (finished at 100 s, then no more samples: it left the list).
function finishersRace() {
    const ctx = {lineM: 0, kind: 'tt', gunMs: null, lengthM: 1000};
    const f = createField();
    simulate(f, [
        {id: 1, startS: 0, speedMs: 5, watching: true, name: 'Home'},
        {id: 2, startS: 0, speedMs: 10, name: 'Quick'},
        {id: 3, startS: 0, speedMs: 6, name: 'Steady'},
    ], 110, ctx);
    return {f, ctx};
}

test('a finisher the list dropped ten minutes ago keeps its finish place and the finisher count', () => {
    const {f, ctx} = finishersRace();
    simulate(f, [
        {id: 1, startS: 0, speedMs: 5, watching: true, name: 'Home'},
        {id: 3, startS: 0, speedMs: 6, name: 'Steady'},
    ], 720, ctx, 111);
    assert.ok(f.riders.has('2'), 'the quick rider is still in the field');
    const list = rows(f, {nowMs: EPOCH + 720_000});
    const quick = list.find(x => x.name === 'Quick');
    assert.ok(quick, 'the quick rider is in the rows');
    assert.equal(quick.finished, true);
    assert.equal(quick.finishPlace, 1, 'first across the line');
    assert.equal(quick.finishers, 3, 'the steady rider and home finish after it: the count is the field\'s');
});

test('a finisher seen two minutes ago is still compared and not put with the not-compared riders', () => {
    const {f, ctx} = finishersRace();
    simulate(f, [
        {id: 1, startS: 0, speedMs: 5, watching: true, name: 'Home'},
        {id: 3, startS: 0, speedMs: 6, name: 'Steady'},
    ], 260, ctx, 111);
    const quick = rows(f, {nowMs: EPOCH + 260_000}).find(x => x.name === 'Quick');
    assert.equal(quick.finished, true);
    assert.equal(quick.stale, false, 'a finisher is not stale');
    assert.equal(quick.comparable, true, 'its finish time stands');
    assert.equal(quick.reason, null);
});

test('a rider who reads 0 m as they leave the event (no category) keeps their race and the home track', () => {
    const ctx = {lineM: 0, kind: 'tt', gunMs: null};
    const f = createField();
    simulate(f, [
        {id: 1, startS: 0, speedMs: 10, watching: true, name: 'Home'},
        {id: 2, startS: 0, speedMs: 8, name: 'Rival'},
    ], 200, ctx);
    const before = f.riders.get('1').lastK;
    assert.ok(before >= 10);
    ingest(f, [entry(1, {t: 201, distanceM: 0, subgroup: 0, watching: true, name: 'Home'}), entry(2, {t: 201, speedMs: 8, name: 'Rival'})], EPOCH + 201_000, ctx);
    const home = f.riders.get('1');
    assert.ok(home.startWT != null, 'still started');
    assert.equal(home.lastK, before, 'the track is kept');
    const list = rows(f, {nowMs: EPOCH + 201_000});
    const me = list.find(x => x.isHome);
    assert.notEqual(me.reason, 'not started');
    const rival = list.find(x => x.name === 'Rival');
    assert.equal(rival.comparable, true, 'the rival is still compared with the home rider');
});

test('a mass start on Zwift\'s own clock: the gun (Unix time from Sauce) is put on the riders\' scale', () => {
    // 2026-11-11 18:40:00 UTC as Unix ms and as Zwift world time (ms from Zwift's own start).
    const gunMs = 1_794_422_400_000;
    const world0 = gunMs - 1_414_016_074_400;
    const riders = [{id: 1, watching: true, speedMs: 11}, {id: 2, speedMs: 10}, {id: 3, speedMs: 12}];
    const f = createField();
    // Every rider reaches the timing line 19 s after the gun: the game's distance is 0 until then.
    for (let t = 0; t <= 200; t++) {
        const list = riders.map(rd => {
            const e = entry(rd.id, {...rd, startS: 19, t});
            e.state.worldTime = world0 + t * 1000;
            return e;
        });
        ingest(f, list, gunMs + t * 1000, {lineM: 0, kind: 'group', gunMs});
    }
    for (const r of f.riders.values()) {
        assert.equal(r.startSource, 'gun', r.name);
        assert.equal(r.startWT, world0, `${r.name}: the gun on the world clock`);
    }
    // 200 s after the gun the clocks are comparable: the faster rider is ahead of home (positive), the slower behind.
    const out = rows(f, {nowMs: gunMs + 200_000});
    const by = id => out.find(r => r.id === String(id));
    assert.ok(by(3).clockS > 5 && by(2).clockS < -5, `clock gaps ${by(3).clockS} and ${by(2).clockS}`);
});

test('a mass start with no start time from Sauce: each rider\'s clock starts at the line, as in a TT', () => {
    const riders = [{id: 1, watching: true, speedMs: 11}, {id: 2, speedMs: 10}];
    const f = simulate(createField(), riders.map(rd => ({...rd, startS: 19})), 120, {lineM: 0, kind: 'group', gunMs: null});
    for (const r of f.riders.values()) {
        assert.notEqual(r.startSource, 'gun', r.name);
        assert.ok(Math.abs(r.startWT - (EPOCH + 19_000)) <= 1000, `${r.name} started at the line: ${r.startWT - EPOCH} ms`);
    }
});
