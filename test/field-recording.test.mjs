// The field model on a real race: the gzipped recording of Dave's Zwift TT on California Dreamin'
// (2026-11-10, route 966890401, anonymised; home rider = id 1). The recording's athlete/watching
// and nearby rows go through the field model the way field-feed.mjs feeds it (the event's length
// from the home tick, the line at metre 0, the TT kind). Each check is against an independent
// computation from the recording's own eventDistance and state.time: the race clock of each rider
// at the same distance is their state.time there (whole seconds, interpolated), and the finish is
// the line at the event's length.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseJsonl} from '../pages/src/replay.mjs';
import {createField, ingest, rows, placeOf, rivalsOf, finishRaceOf} from '../pages/src/engine/field-model.mjs';
import {finishOutlook} from '../pages/src/engine/finish-outlook.mjs';

const rec = parseJsonl(gunzipSync(readFileSync(new URL('./fixtures/recordings/california-dreamin-2026-11-10.jsonl.gz', import.meta.url))).toString('utf8'));
const EPOCH = rec[0].d.startedAt;
const HOME = '1';
const CATEGORY = '7452316';
const STALE_MS = 120_000;
const EVICT_MS = 600_000;
// The race's length: the home tick's remainingEnd while the home rider raced (the game reports
// another length once it has ridden on past the finish; the engine keeps the first).
const EVENT_M = 21155.5322265625;
// The "clock" tolerance: state.time is whole seconds, the engine reads the world clock.
const CLOCK_TOL_S = 1.5;

/** The event's length from the home tick, as the engine reads it (remainingMetric 'distance'). */
function lengthOfTick(d) {
    const end = Number(d?.remainingEnd);
    return d?.remainingMetric === 'distance' && Number.isFinite(end) && end > 0 ? end : null;
}

/** Feeds rows up to t ms into the field, as the windows do (field-feed.mjs and the tick). */
function replayTo(state, tMs) {
    while (state.i < rec.length && rec[state.i].t <= tMs) {
        const row = rec[state.i++];
        if (row.ch === 'athlete/watching') {
            state.lengthM = lengthOfTick(row.d) ?? state.lengthM;
        } else if (row.ch === 'nearby') {
            ingest(state.field, row.d, EPOCH + row.t, {lineM: 0, kind: 'tt', gunMs: null, lengthM: state.lengthM});
        }
    }
    return state;
}

function newReplay() {
    return {i: 0, field: createField(), lengthM: null};
}

/** The recording's own view of each rider up to t ms: their samples, last sight and category. */
function truthUpTo(tMs, lengthM) {
    const riders = new Map();
    for (const row of rec) {
        if (row.t > tMs) {
            break;
        }
        if (row.ch !== 'nearby') {
            continue;
        }
        for (const e of row.d) {
            const id = String(e.athleteId);
            let r = riders.get(id);
            if (!r) {
                r = {id, name: e.athlete?.sanitizedFullname ?? id, samples: [], lastSeenMs: null, category: null, crossing: null};
                riders.set(id, r);
            }
            const sg = e.state?.eventSubgroupId;
            if (sg && String(sg) !== '0') {
                r.category = String(sg);
            }
            // Unseen for ten minutes, the field forgets an unfinished rider (evicted): so does this.
            // A finisher is kept (its finish place stands).
            if (r.lastSeenMs != null && EPOCH + row.t - r.lastSeenMs > EVICT_MS && r.crossing == null) {
                r.samples = [];
                r.crossing = null;
            }
            r.lastSeenMs = EPOCH + row.t;
            const m = Number(e.state?.eventDistance);
            const time = Number(e.state?.time);
            if (!Number.isFinite(m) || !Number.isFinite(time)) {
                continue;
            }
            // Samples up to the line, and the first one past it: the race is over for the rider
            // there, and their later riding is not part of it (the engine ignores it too).
            const last = r.samples.at(-1);
            if (!last || last.m < lengthM) {
                if (last && last.m < lengthM && m >= lengthM && r.crossing == null) {
                    const f = (lengthM - last.m) / (m - last.m);
                    r.crossing = {time: last.time + (time - last.time) * f, sampleTime: time};
                }
                r.samples.push({m, time, t: row.t});
            }
        }
    }
    return riders;
}

/**
 * The race time of a rider at distance d, interpolated from their samples; null across a gap of
 * more than 20 s between two samples (the rider was out of the list then).
 */
function timeAtTruth(r, d) {
    const s = r.samples;
    for (let i = 1; i < s.length; i++) {
        if (s[i].m >= d && s[i - 1].m <= d && s[i].m > s[i - 1].m) {
            if (s[i].t - s[i - 1].t > 20_000) {
                return null;
            }
            const f = (d - s[i - 1].m) / (s[i].m - s[i - 1].m);
            return s[i - 1].time + (s[i].time - s[i - 1].time) * f;
        }
    }
    return null;
}

/** The latest distance (a multiple of 50 m, at or below the riders' latest) both have a time at. */
function sharedDistance(home, r, lengthM) {
    const top = Math.min(home.samples.at(-1).m, r.samples.at(-1).m, lengthM);
    for (let d = Math.floor(top / 50) * 50, steps = 0; d >= 50 && steps < 200; d -= 50, steps++) {
        if (timeAtTruth(home, d) != null && timeAtTruth(r, d) != null) {
            return d;
        }
    }
    return null;
}

/** Each rider's like-for-like gap to you (positive: ahead) and place, from the recording alone. */
function truthAt(tMs, lengthM) {
    const riders = truthUpTo(tMs, lengthM);
    const home = riders.get(HOME);
    const out = new Map();
    for (const r of riders.values()) {
        if (r.id === HOME || r.category !== CATEGORY || r.samples.length < 2) {
            continue;
        }
        // A finisher is not stale: its finish time and place stand, however long it is unseen.
        const finished = r.crossing != null;
        const stale = !finished && tMs - (r.lastSeenMs - EPOCH) > STALE_MS;
        const d = sharedDistance(home, r, lengthM);
        if (d == null) {
            out.set(r.id, {comparable: false, stale});
            continue;
        }
        out.set(r.id, {comparable: !stale, stale, gapS: timeAtTruth(home, d) - timeAtTruth(r, d)});
    }
    return out;
}

// Moments in the race (seconds from the recording's start): early, the climb, the middle, late, near
// the finish, at the line, and after the home rider finished (race time 2095 s).
const MOMENTS = [400, 1150, 1450, 1850, 2149, 2240, 2300];

test('the recording is a real race: the home rider is the self entry, the event is 21155.5 m', () => {
    const nearby = rec.filter(r => r.ch === 'nearby');
    assert.ok(nearby.length > 900);
    assert.ok(nearby.every(r => r.d.some(e => e.self && String(e.athleteId) === HOME)));
    const ticks = rec.filter(r => r.ch === 'athlete/watching');
    assert.equal(lengthOfTick(ticks[0].d), EVENT_M);
});

test('like-for-like gaps and places at several moments match the recording\'s own race clocks', () => {
    const state = newReplay();
    for (const sec of MOMENTS) {
        replayTo(state, sec * 1000);
        const nowMs = EPOCH + sec * 1000;
        const list = rows(state.field, {nowMs});
        const truth = truthAt(sec * 1000, EVENT_M);
        const byId = new Map(list.map(r => [r.id, r]));
        let compared = 0;
        for (const [id, t] of truth) {
            const r = byId.get(id);
            if (!r) {
                // Evicted by the field after ten minutes unseen: not compared, as the recording says.
                assert.ok(t.stale, `${sec} s: rider ${id} missing but seen recently`);
                continue;
            }
            assert.equal(r.comparable, t.comparable, `${sec} s: ${r.name} comparable (${r.reason ?? ''})`);
            if (t.comparable) {
                compared++;
                assert.ok(Math.abs(r.clockS - t.gapS) < CLOCK_TOL_S, `${sec} s ${r.name}: engine ${r.clockS?.toFixed(2)} s, recording ${t.gapS.toFixed(2)} s`);
            }
        }
        const home = byId.get(HOME);
        assert.ok(home.comparable, `${sec} s: home compared`);
        const ahead = [...truth.values()].filter(t => t.comparable && t.gapS > 0).length;
        const of = [...truth.values()].filter(t => t.comparable).length + 1;
        const pl = placeOf(list);
        assert.equal(pl.place, ahead + 1, `${sec} s: place ${pl.place} vs recording ${ahead + 1}`);
        assert.equal(pl.of, of, `${sec} s: of ${pl.of} vs recording ${of}`);
        assert.equal(home.place, ahead + 1, `${sec} s: the home row's place`);
        assert.ok(compared > 0);
    }
});

test('the place in the rivals strip is the same like-for-like place (no road order anywhere)', () => {
    const state = newReplay();
    replayTo(state, 1450_000);
    const list = rows(state.field, {nowMs: EPOCH + 1450_000});
    const rv = rivalsOf(list, {each: 2});
    assert.equal(rv.ahead.length, 2);
    assert.equal(rv.behind.length, 2);
    assert.ok(rv.ahead.every(r => r.gapS > 0) && rv.behind.every(r => r.gapS <= 0));
    for (const r of list) {
        assert.equal(Object.keys(r).some(k => /road/i.test(k)), false, 'no road figure in a row');
    }
});

test('the finish: each rider who crosses the line has a frozen race time equal to the recording\'s own clock there', () => {
    const state = newReplay();
    replayTo(state, rec.at(-1).t);
    const truth = truthUpTo(rec.at(-1).t, EVENT_M);
    let checked = 0;
    for (const [id, t] of truth) {
        if (!t.crossing) {
            continue;
        }
        const mine = finishRaceOf(state.field.riders.get(id));
        assert.ok(Number.isFinite(mine), `${t.name} has a finish time`);
        assert.ok(Math.abs(mine - t.crossing.time) < 1, `${t.name}: ${mine.toFixed(2)} s, recording ${t.crossing.time.toFixed(2)} s`);
        checked++;
    }
    assert.ok(checked >= 15, `${checked} crossings checked`);
});

test('a finished rider is frozen at the line: later riding changes neither their clock nor their gaps', () => {
    const state = newReplay();
    replayTo(state, 2300_000);
    const before = rows(state.field, {nowMs: EPOCH + 2300_000});
    const finishers = before.filter(r => r.finished && !r.isHome && r.comparable);
    assert.ok(finishers.length >= 5, `${finishers.length} finishers compared`);
    replayTo(state, rec.at(-1).t);
    const after = new Map(rows(state.field, {nowMs: EPOCH + rec.at(-1).t}).map(r => [r.id, r]));
    for (const r of finishers) {
        const a = after.get(r.id);
        assert.equal(a.finishRaceS, r.finishRaceS, `${r.name} finish time unchanged`);
        const rider = state.field.riders.get(r.id);
        assert.equal(rider.lastK, Math.floor(EVENT_M / 50), `${r.name} checkpoints stop at the line`);
    }
});

test('the home rider finishes on its own clock, and its finish place is its order among the finishers', () => {
    const state = newReplay();
    const finishT = rec.find(r => r.ch === 'athlete/watching' && Number(r.d.remaining) <= 0)?.t;
    assert.ok(finishT > 0);
    replayTo(state, finishT + 5000);
    const home = state.field.riders.get(HOME);
    assert.ok(home.finished, 'home finished');
    const homeFinish = finishRaceOf(home);
    assert.ok(Math.abs(homeFinish - 2095) < 1.5, `home finish ${homeFinish}`);
    const list = rows(state.field, {nowMs: EPOCH + finishT + 5000});
    const me = list.find(r => r.isHome);
    assert.equal(me.finished, true);
    // The recording's finish order among the riders of the category who crossed by now.
    const truth = truthUpTo(finishT + 5000, EVENT_M);
    const others = [...truth.values()].filter(t => t.id !== HOME && t.category === CATEGORY && t.crossing).map(t => t.crossing.time);
    const ahead = others.filter(c => c < homeFinish).length;
    assert.equal(me.finishPlace, ahead + 1, `home finish place ${me.finishPlace}, recording ${ahead + 1}`);
    assert.equal(me.finishers, others.length + 1, 'finishers counted as the recording counts them (you included)');
    // The outlook at the finish: you are through, and the verdict is done.
    const o = finishOutlook(list, {remainingS: 0, elapsedS: homeFinish});
    assert.equal(o.verdict.kind, 'done');
    assert.equal(o.home.finishPlace, me.finishPlace);
});
