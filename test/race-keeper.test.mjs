// Keep race recordings: the marks every window writes, when a race is saved, dropped or forgotten,
// what a kept tick holds, and a real race (Fan Flats, joined from a warm-up) through the engine
// and a window's race watch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {
    MARKS_KEY, LEAD_MS, TAIL_MS, STALE_MS, MAX_RACE_MS, MIN_RACE_MS, MARK_FORGET_MS, LATE_JOIN_MS, SEEN_EVERY_MS,
    subgroupOfTick, observeTick, mergeMark, applyPatches, endOf, raceWindow, marksDue, racesToExpire, keepFrom,
    slimTick, viewSnapshot, raceFileName,
} from '../pages/src/race-keeper.mjs';
import {createRaceWatch} from '../pages/src/views/race-watch.mjs';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const load = name => parseJsonl(gunzipSync(readFileSync(new URL(`${name}.jsonl.gz`, dir))).toString('utf8'));
const isHome = r => r.ch === 'athlete/watching';

const T0 = Date.UTC(2026, 10, 22, 18, 10);
const tick = (sg, {time = 0, ed = 0, remaining = 10000, remainingType = sg ? 'event' : 'route', routeId} = {}) =>
    ({state: {eventSubgroupId: sg ?? 0, time, eventDistance: ed, ...(routeId ? {routeId} : {})}, remaining, remainingType});

/** Feeds ticks [{at, tick, info}] through one window; returns the shared marks and the window's memory. */
function feed(steps, {marks = {}, local = null} = {}) {
    for (const {at, tick: t, info} of steps) {
        const out = observeTick(local, t, at, info);
        local = out.local;
        marks = applyPatches(marks, out.patches) ?? marks;
    }
    return {marks, local};
}

test('subgroupOfTick: Zwift says no event with 0 or nothing', () => {
    assert.equal(subgroupOfTick(tick(0)), null);
    assert.equal(subgroupOfTick({state: {}}), null);
    assert.equal(subgroupOfTick(null), null);
    assert.equal(subgroupOfTick(tick(7457948)), '7457948');
    assert.equal(subgroupOfTick({eventSubgroupId: 12}), '12');
});

test('a race: join, pen, line, finish, leave', () => {
    const sg = '900';
    const {marks} = feed([
        {at: T0, tick: tick(0)},
        {at: T0 + 1000, tick: tick(sg, {time: 0, ed: 0})},                               // the pen
        {at: T0 + 120000, tick: tick(sg, {time: 1, ed: 10, remaining: 9990}), info: {name: 'Stage 2 - Zwift TT - Seafoam Circuit', code: 'KTFFX9', routeId: 4045681681}},
        {at: T0 + 1800000, tick: tick(sg, {time: 1680, ed: 10001, remaining: -1})},     // over the line
        {at: T0 + 1900000, tick: tick(0)},                                               // left the event
    ]);
    const m = marks[sg];
    assert.equal(m.joinedAt, T0 + 1000);
    assert.equal(m.startAt, T0 + 120000);
    assert.equal(m.finishAt, T0 + 1800000);
    assert.equal(m.timeS, 1680);
    assert.equal(m.leftAt, T0 + 1900000);
    assert.equal(m.name, 'Stage 2 - Zwift TT - Seafoam Circuit');
    assert.equal(m.code, 'KTFFX9');
    assert.equal(m.routeId, '4045681681');
    assert.equal(endOf(m), m.finishAt, 'the finish, not leaving, ends the race');
});

test('joining from a free ride: the event timer on the first ticks is the free ride\'s, not the race', () => {
    const sg = '901';
    // Joined mid warm-up: the subgroup comes with the warm-up's timer running and the event's
    // distance to go, for a few seconds before the pen.
    const stale = tick(sg, {time: 1564, ed: 12785, remaining: 6642});
    const early = feed([
        {at: T0, tick: stale},
        {at: T0 + LATE_JOIN_MS - 1000, tick: stale},
    ]);
    assert.equal(early.marks[sg].startAt ?? null, null, 'not started on the warm-up\'s timer');
    const pen = feed([{at: T0 + 3000, tick: tick(sg)}], early);
    assert.equal(pen.marks[sg].startAt ?? null, null);
    const line = feed([{at: T0 + 200000, tick: tick(sg, {time: 1, ed: 11, remaining: 19415})}], pen);
    assert.equal(line.marks[sg].startAt, T0 + 200000);
    // No pen seen at all (a window opened late): the timer counts once 10 s have gone by.
    const late = feed([{at: T0, tick: stale}, {at: T0 + LATE_JOIN_MS, tick: stale}]);
    assert.equal(late.marks[sg].startAt, T0 + LATE_JOIN_MS);
});

test('the engine starts and finishes a race the ticks alone do not', () => {
    const sg = '902';
    const {marks} = feed([
        {at: T0, tick: tick(sg, {remainingType: 'route'})},
        {at: T0 + 2000, tick: tick(sg, {time: 0, ed: 0, remainingType: 'route'}), info: {engineStatus: 'racing'}},
        {at: T0 + 900000, tick: tick(sg, {time: 898, ed: 9000, remainingType: 'route'}), info: {engineStatus: 'finished', raceS: 897.4}},
    ]);
    assert.equal(marks[sg].startAt, T0 + 2000);
    assert.equal(marks[sg].finishAt, T0 + 900000);
    assert.equal(marks[sg].timeS, 897.4, 'the engine\'s race time over the event timer');
});

test('a finish needs a start: a stale tick at zero to go before the line is not a finish', () => {
    const sg = '903';
    const {marks} = feed([{at: T0, tick: tick(sg, {time: 900, ed: 9000, remaining: -2})}]);
    assert.equal(marks[sg].finishAt ?? null, null);
});

test('sightings: every minute while nothing else changes', () => {
    const sg = '904';
    let local = null;
    let writes = 0;
    for (let s = 0; s <= 600; s++) {
        const out = observeTick(local, tick(sg, {remainingType: 'route', time: 0, ed: 0}), T0 + s * 1000);
        local = out.local;
        writes += out.patches.length;
    }
    assert.ok(writes >= 600000 / SEEN_EVERY_MS && writes <= 600000 / SEEN_EVERY_MS + 2, `${writes} writes in ten minutes`);
});

test('mergeMark: two windows\' notes give the same mark in either order', () => {
    const a = {key: '9', joinedAt: 100, startAt: 300, seenAt: 900, name: 'TT', code: 'AAA'};
    const b = {key: '9', joinedAt: 150, startAt: 290, finishAt: 800, seenAt: 1000, timeS: 500, routeId: '7'};
    const ab = mergeMark(a, b);
    const ba = mergeMark(b, a);
    for (const f of ['joinedAt', 'startAt', 'finishAt', 'seenAt', 'timeS', 'name', 'routeId']) {
        assert.equal(ab[f], ba[f], f);
    }
    assert.deepEqual([ab.joinedAt, ab.startAt, ab.finishAt, ab.seenAt], [100, 290, 800, 1000]);
    assert.equal(mergeMark(null, b).finishAt, 800);
    assert.equal(mergeMark(a, null).name, 'TT');
    assert.equal(applyPatches({}, []), null, 'nothing to write');
});

test('marksDue: running races are left alone; over ones saved; no race dropped; done ones forgotten', () => {
    const now = T0 + 3 * 3600000;
    const marks = {
        running: {key: 'running', joinedAt: now - 1800000, startAt: now - 1700000, seenAt: now - 1000},
        justFinished: {key: 'justFinished', joinedAt: now - 3600000, startAt: now - 3500000, finishAt: now - TAIL_MS + 1000, seenAt: now},
        finished: {key: 'finished', joinedAt: now - 3600000, startAt: now - 3500000, finishAt: now - TAIL_MS, seenAt: now},
        left: {key: 'left', joinedAt: now - 3600000, startAt: now - 3500000, leftAt: now - TAIL_MS, seenAt: now - TAIL_MS},
        closed: {key: 'closed', joinedAt: now - 3600000, startAt: now - 3500000, seenAt: now - STALE_MS},
        neverStarted: {key: 'neverStarted', joinedAt: now - 900000, leftAt: now - 600000, seenAt: now - 600000},
        tooShort: {key: 'tooShort', joinedAt: now - 900000, startAt: now - 700000, leftAt: now - 700000 + MIN_RACE_MS - 1, seenAt: now - 600000},
        tooLong: {key: 'tooLong', joinedAt: T0 - 1000, startAt: now - MAX_RACE_MS, seenAt: now},
        doneRecent: {key: 'doneRecent', startAt: now - 7200000, doneAt: now - 3600000, seenAt: now - 3600000},
        doneOld: {key: 'doneOld', startAt: now - 2 * MARK_FORGET_MS, doneAt: now - MARK_FORGET_MS, seenAt: now - MARK_FORGET_MS},
    };
    const due = marksDue(marks, now);
    assert.deepEqual(due.save.map(m => m.key).sort(), ['closed', 'finished', 'left', 'tooLong']);
    assert.deepEqual(due.drop.sort(), ['neverStarted', 'tooShort']);
    assert.deepEqual(due.forget, ['doneOld']);
    assert.deepEqual(marksDue(null, now), {save: [], drop: [], forget: []});
});

test('raceWindow: ten minutes before the join to two after the end, four hours at most', () => {
    const m = {joinedAt: T0, startAt: T0 + 300000, finishAt: T0 + 2100000, leftAt: T0 + 2400000};
    assert.deepEqual(raceWindow(m), {fromAt: T0 - LEAD_MS, toAt: T0 + 2100000 + TAIL_MS});
    assert.equal(raceWindow({startAt: T0, seenAt: T0 + 3600000}).fromAt, T0 - LEAD_MS, 'no join seen: from the start');
    assert.equal(raceWindow({joinedAt: T0, startAt: T0, seenAt: T0 + 10 * 3600000}).toAt, T0 + MAX_RACE_MS);
});

test('keepFrom: the recorder keeps what the unsaved races need', () => {
    assert.equal(keepFrom({}), null);
    assert.equal(keepFrom({
        a: {key: 'a', joinedAt: T0 + 60000},
        b: {key: 'b', startAt: T0},
        c: {key: 'c', joinedAt: T0 - 7200000, doneAt: T0},
    }), T0 - LEAD_MS);
});

test('racesToExpire: a fortnight, then the oldest past the size cap', () => {
    const now = T0;
    const day = 86400000;
    const races = [
        {key: 'old', savedAt: now - 15 * day, bytes: 1},
        {key: 'a', savedAt: now - 3 * day, bytes: 40},
        {key: 'b', savedAt: now - 2 * day, bytes: 40},
        {key: 'c', savedAt: now - 1 * day, bytes: 40},
    ];
    assert.deepEqual(racesToExpire(races, now, {maxBytes: 1000}), ['old']);
    assert.deepEqual(racesToExpire(races, now, {maxBytes: 100}), ['old', 'a']);
    assert.deepEqual(racesToExpire([], now), []);
});

test('slimTick: drops Sauce\'s statistics and keeps what the mod reads', () => {
    const recording = load('fan-flats-2026-11-18');
    const home = recording.find(r => isHome(r) && r.d.state?.eventSubgroupId).d;
    // The fixture's ticks were trimmed when it was made; a live tick also carries Sauce's statistics.
    const stats = {power: {avg: 250, max: 600, np: 260, peaks: {5: {avg: 600}, 60: {avg: 400}, 300: {avg: 300}}}, hr: {avg: 150}, speed: {avg: 40}};
    const full = {
        ...home,
        athlete: {...(home.athlete ?? {}), id: 1, weight: 70, avatar: 'https://example/a.jpg', powerProfile: {x: new Array(50).fill(1)}},
        state: {...home.state, playerVFXs: [1, 2, 3]},
        stats, lap: stats, lastLap: stats, laps: [stats, stats], segmentData: {a: 1}, timeInPowerZones: [{zone: 1, time: 10}],
    };
    const slim = slimTick(full);
    for (const k of ['stats', 'lap', 'lastLap', 'laps', 'segmentData', 'timeInPowerZones']) {
        assert.equal(slim[k], undefined, k);
    }
    assert.equal(slim.state.playerVFXs, undefined);
    assert.equal(slim.athlete.powerProfile, undefined);
    assert.deepEqual(slim.state, home.state, 'the whole state the engine reads');
    assert.equal(slim.remaining, full.remaining);
    assert.equal(slim.remainingType, full.remainingType);
    assert.equal(slim.eventSubgroupId, full.eventSubgroupId);
    assert.deepEqual([slim.athlete.id, slim.athlete.weight], [1, 70]);
    assert.deepEqual(slimTick(home).state, home.state, 'an already trimmed tick goes through');
    assert.equal(slimTick(null), null);
});

test('raceFileName: the start time and the event, without the series prefix', () => {
    const race = {startAt: new Date(2026, 10, 22, 18, 22).getTime(), name: 'Stage 2 - Zwift TT - Seafoam Circuit'};
    assert.equal(raceFileName(race), 'zg-tt-race-2026-11-22-1822-seafoam-circuit.jsonl.gz');
    assert.match(raceFileName({savedAt: 0, key: '7457948'}), /^zg-tt-race-\d{4}-\d\d-\d\d-\d{4}-7457948\.jsonl\.gz$/);
    assert.match(raceFileName({startAt: 0, name: '***'}), /-race\.jsonl\.gz$/);
});

test('viewSnapshot: the engine\'s view in a line', () => {
    assert.equal(viewSnapshot(null), null);
    const s = viewSnapshot({status: 'racing', plan: {code: 'X'}, race: {planM: 100, deltaS: -2}, target: {number: 3, powerW: 250}}, {locked: true});
    assert.deepEqual([s.status, s.code, s.planM, s.deltaS, s.number, s.targetW, s.locked], ['racing', 'X', 100, -2, 3, 250, true]);
});

// --- A real race through the engine and a window's race watch -------------------------------------

function memoryStorage() {
    const store = new Map();
    return {
        get: k => store.has(k) ? structuredClone(store.get(k)) : undefined,
        set: (k, v) => store.set(k, structuredClone(v)),
    };
}

function fakeRecorder({keeping = true, active = true, writes = true} = {}) {
    const records = [];
    const saved = [];
    return {
        records, saved,
        isKeeping: () => keeping,
        isActive: () => active,
        writesChannel: () => writes,
        record: (ch, d, opts) => records.push({ch, d, opts}),
        saveRace: async mark => {
            saved.push(mark);
            return {key: mark.key, bytes: 1};
        },
        expireRaces: async () => [],
    };
}

test('Fan Flats: joined from a warm-up, the race mark runs from the join to the finish and is saved two minutes later', async () => {
    const recording = load('fan-flats-2026-11-18');
    const meta = metaOf(recording);
    const plan = normalisePlan(JSON.parse(readFileSync(new URL('fan-flats-2026-11-18.plan.json', dir), 'utf8')));
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    const storage = memoryStorage();
    const recorder = fakeRecorder();
    const watch = createRaceWatch({storage, engine, recorder});
    const home = recording.filter(isHome);
    const at = row => meta.startedAt + row.t;
    const joinRow = home.find(r => r.d.state.eventSubgroupId);
    const lineRow = home.find(r => r.d.state.eventSubgroupId && r.d.state.time > 0 && r.d.state.eventDistance > 0 && r.d.state.eventDistance < 100);
    const finishRow = home.find(r => r.d.state.eventSubgroupId && r.d.remainingType === 'event' && r.d.remaining <= 0 && r.d.state.eventDistance > 1000);
    // The runtime asks Sauce about the event once the engine has the subgroup; the recording
    // has the answer a little before the first tick in the event.
    const info = recording.find(r => r.ch === 'rpc' && r.d.method === 'getEventSubgroup').d.result;
    let sweptEarly = null;
    for (const row of recording) {
        if (!isHome(row)) {
            continue;
        }
        engine.tick(row.d, at(row));
        if (row === joinRow) {
            engine.event('eventInfo', {subgroupId: String(info.id), kind: 'tt', startMs: info.eventSubgroupStart, name: info.name}, at(row));
        }
        watch.tick(row.d, at(row));
        if (row === finishRow) {
            sweptEarly = await watch.sweep(at(row) + TAIL_MS - 1000);
        }
    }
    const sg = String(joinRow.d.state.eventSubgroupId);
    const mark = storage.get(MARKS_KEY)[sg];
    assert.equal(mark.joinedAt, at(joinRow), 'joined on the first tick in the event');
    assert.ok(Math.abs(mark.startAt - at(lineRow)) <= 1000, `started at the line, not on the warm-up (${(mark.startAt - at(lineRow)) / 1000} s)`);
    assert.ok(Math.abs(mark.finishAt - at(finishRow)) <= 1000, `finished at the line (${(mark.finishAt - at(finishRow)) / 1000} s)`);
    assert.ok(mark.timeS > 1900 && mark.timeS < 2100, `race time ${mark.timeS}`);
    assert.equal(mark.name, info.name);
    assert.deepEqual(sweptEarly.saved, [], 'not saved inside two minutes of the finish');

    // The engine's own reading went into the recording: its log lines once each, its view at 1 Hz.
    const logs = recorder.records.filter(r => r.ch === 'zg/log');
    assert.equal(logs.length, new Set(logs.map(r => r.d)).size);
    assert.ok(logs.some(r => /racing|line/i.test(r.d.msg)), 'the start is in the log');
    const states = recorder.records.filter(r => r.ch === 'zg/state');
    // Once a second at most (the recording ticks slower in the pen and has gaps).
    const spanS = (home.at(-1).t - home[0].t) / 1000;
    const tickedS = new Set(home.map(r => Math.floor(r.t / 1000))).size;
    assert.ok(states.length > tickedS * 0.85 && states.length <= spanS + 1, `${states.length} snapshots, ${tickedS} s with ticks over ${spanS.toFixed(0)} s`);
    assert.ok(states.every(r => r.opts?.owner === 'zg'));

    const done = await watch.sweep(mark.finishAt + TAIL_MS);
    assert.deepEqual(done.saved.map(s => s.key), [sg]);
    assert.equal(recorder.saved[0].startAt, mark.startAt);
    const after = storage.get(MARKS_KEY)[sg];
    assert.ok(after.doneAt != null && after.saved === true);
    assert.deepEqual((await watch.sweep(mark.finishAt + TAIL_MS + 30000)).saved, [], 'saved once');
    assert.deepEqual((await watch.sweep(after.doneAt + MARK_FORGET_MS + 1)).forgotten, [sg]);
    assert.equal(storage.get(MARKS_KEY)[sg], undefined);
});

test('race watch: off, spectating, or another window writing the ticks: no marks, no saves', async () => {
    const recording = load('hilly-race-2026-11-11');
    const meta = metaOf(recording);
    const home = recording.filter(isHome);

    const off = fakeRecorder({keeping: false, active: false});
    const offStorage = memoryStorage();
    const offWatch = createRaceWatch({storage: offStorage, engine: createEngine(), recorder: off});
    for (const row of home) {
        offWatch.tick(row.d, meta.startedAt + row.t);
    }
    assert.equal(offStorage.get(MARKS_KEY), undefined);
    assert.equal(off.records.length, 0);
    assert.equal(await offWatch.sweep(meta.startedAt + home.at(-1).t + 3600000), null);

    const spectating = createEngine();
    spectating.state.spectating = {athleteId: 1, name: 'someone'};
    const specStorage = memoryStorage();
    const specWatch = createRaceWatch({storage: specStorage, engine: spectating, recorder: fakeRecorder()});
    specWatch.tick(home.at(-100).d, meta.startedAt + home.at(-100).t);
    assert.equal(specStorage.get(MARKS_KEY), undefined);

    // Two windows: both write marks, only the one writing the ticks saves.
    const storage = memoryStorage();
    const a = createRaceWatch({storage, engine: createEngine(), recorder: fakeRecorder({writes: true})});
    const bRec = fakeRecorder({writes: false});
    const b = createRaceWatch({storage, engine: createEngine(), recorder: bRec});
    for (const [i, row] of home.entries()) {
        (i % 2 ? a : b).tick(row.d, meta.startedAt + row.t);
    }
    const marks = storage.get(MARKS_KEY);
    const [mark] = Object.values(marks);
    assert.ok(mark.startAt && mark.finishAt && mark.joinedAt);
    const end = mark.finishAt + TAIL_MS;
    assert.equal(await b.sweep(end), null);
    assert.equal(bRec.saved.length, 0);
    assert.equal((await a.sweep(end)).saved.length, 1);
});

test('California Dreamin\': leaving the event after the finish keeps the finish as the end', () => {
    const recording = load('california-dreamin-2026-11-10');
    const meta = metaOf(recording);
    let local = null;
    let marks = {};
    for (const row of recording.filter(isHome)) {
        const out = observeTick(local, row.d, meta.startedAt + row.t);
        local = out.local;
        marks = applyPatches(marks, out.patches) ?? marks;
    }
    const [mark] = Object.values(marks);
    assert.ok(mark.leftAt > mark.finishAt, 'left after the finish');
    assert.equal(endOf(mark), mark.finishAt);
    const {fromAt, toAt} = raceWindow(mark);
    assert.equal(toAt - fromAt, mark.finishAt - mark.joinedAt + LEAD_MS + TAIL_MS);
    assert.ok(mark.timeS > 2000 && mark.timeS < 2200, `timer at the finish ${mark.timeS}`);
});

test('leaving the event and joining it again is not the end of the race: it is still saved, whole (audit 9)', () => {
    const sg = '900';
    const min = m => T0 + m * 60000;
    const {marks} = feed([
        {at: min(0), tick: tick(sg, {time: 0, ed: 0})},
        {at: min(2), tick: tick(0)},                                                  // out of the event ...
        {at: min(2) + 6000, tick: tick(sg, {time: 0, ed: 0})},                        // ... and back in the pen six seconds later
        {at: min(4) + 6000, tick: tick(sg, {time: 0, ed: 0})},
        {at: min(10), tick: tick(sg, {time: 1, ed: 10, remaining: 19990})},           // the gun
        {at: min(30), tick: tick(sg, {time: 1200, ed: 15000, remaining: 5000})},
        {at: min(40), tick: tick(sg, {time: 1800, ed: 20001, remaining: -1})},        // the line
    ]);
    const mark = marks[sg];
    assert.equal(mark.leftAt, null, 'back in the event: not left');
    assert.deepEqual(marksDue(marks, min(4) + 6000 + TAIL_MS + 1), {save: [], drop: [], forget: []}, 'not dropped as a race that never started');
    assert.deepEqual(marksDue(marks, mark.finishAt + TAIL_MS).save.map(m => m.key), [sg], 'saved two minutes after the finish');

    // One tick without the event in the middle of the race does not cut it short either.
    const cut = feed([
        {at: min(10), tick: tick(sg, {time: 1, ed: 10, remaining: 19990})},
        {at: min(15), tick: tick(0)},
        {at: min(15) + 1000, tick: tick(sg, {time: 300, ed: 5000, remaining: 15000})},
    ]);
    assert.equal(cut.marks[sg].leftAt, null);
    assert.deepEqual(marksDue(cut.marks, min(15) + 1000 + TAIL_MS + 1000).save, [], 'still running');

    // Leaving for good after the race still ends it, in either order of the windows' notes.
    const left = {key: sg, leftAt: min(41), seenAt: min(41)};
    const back = {key: sg, backAt: min(0)};
    assert.equal(mergeMark(mergeMark(marks[sg], left), back).leftAt, min(41));
    assert.equal(mergeMark(mergeMark(back, left), marks[sg]).leftAt, min(41));
});

test('a race whose save failed is saved at a later sweep; after five failures it is given up (audit 9)', async () => {
    const storage = memoryStorage();
    const T = Date.UTC(2026, 10, 28, 18, 0);
    storage.set(MARKS_KEY, {900: {key: '900', subgroupId: '900', joinedAt: T, startAt: T + 600000, finishAt: T + 2400000, seenAt: T + 2400000, timeS: 1800}});
    let calls = 0;
    let failing = 3;
    const recorder = {...fakeRecorder(), saveRace: async mark => {
        calls++;
        if (failing-- > 0) {
            throw new Error('QuotaExceededError');
        }
        return {key: mark.key, bytes: 1};
    }};
    const watch = createRaceWatch({storage, engine: {state: {}}, recorder});
    const warn = console.warn;
    console.warn = () => {};
    try {
        const over = T + 2400000 + TAIL_MS + 1000;
        assert.deepEqual((await watch.sweep(over)).saved, []);
        assert.equal(storage.get(MARKS_KEY)['900'].doneAt ?? null, null, 'not done: it will be tried again');
        await watch.sweep(over + 30000);
        await watch.sweep(over + 60000);
        const saved = await watch.sweep(over + 90000);
        assert.deepEqual(saved.saved.map(s => s.key), ['900'], 'the fourth try saved it');
        assert.equal(storage.get(MARKS_KEY)['900'].saved, true);
        assert.equal(calls, 4);

        // A disk that stays broken: five tries, then done and not saved.
        storage.set(MARKS_KEY, {901: {key: '901', subgroupId: '901', joinedAt: T, startAt: T + 600000, finishAt: T + 2400000, seenAt: T + 2400000}});
        failing = Infinity;
        calls = 0;
        for (let i = 0; i < 8; i++) {
            await watch.sweep(over + 200000 + i * 30000);
        }
        assert.equal(calls, 5);
        assert.deepEqual([storage.get(MARKS_KEY)['901'].saved, storage.get(MARKS_KEY)['901'].doneAt != null], [false, true]);
    } finally {
        console.warn = warn;
    }
});
