// Telemetry recorder (docs/REVAMP_PLAN.md Phase 0.2) and the races kept from it (race-keeper.mjs).
//
// Keeps the last two hours of the channels a window records through sauce.subscribe()
// ('athlete/watching' from the dashboard, 'nearby' from the field window, RPC results from
// sauce.rpc, and the mod's own view of the race, 'zg/state' and 'zg/log'), trimmed, in
// IndexedDB, which every window of the mod shares. Two switches run it:
//   Record telemetry (/zg-tt/recorder = {enabled, startedAt}): the whole ticks, for test
//     fixtures and ?replay=idb; turning it on starts a fresh recording; Save writes it out.
//   Keep race recordings (/zg-tt/race-keeper = {enabled}): slim ticks all the time, and each
//     race the rider rides cut out of them when it is over, compressed, and kept 14 days
//     (store 'races'); Settings lists them to save one to a file. ?replay=race-<key> replays one.
// Rows carry the unix time they were written (at); exports count from the first.
import {storage} from './mod-storage.mjs';
import {VERSION} from './version.mjs';
import {KEEP_KEY, MARKS_KEY, slimTick, keepFrom, raceWindow, racesToExpire} from './race-keeper.mjs';

export const CONTROL_KEY = '/zg-tt/recorder';
const DB_NAME = 'zg-tt-recorder';
const DB_VERSION = 2;               // 2 (0.9.8): rows by unix time, an index on it, the saved races
const STORE = 'ticks';
const RACES = 'races';
const MAX_AGE_MS = 2 * 3600 * 1000;
const MAX_USAGE_BYTES = 800 * 1024 * 1024;   // the whole store; past it the buffer keeps 30 minutes
const SHORT_AGE_MS = 30 * 60 * 1000;
const NEARBY_PERIOD_MS = 2000;
const PRUNE_EVERY = 120;
const WATCHING_DROP = new Set(['laps', 'segments', 'events', 'streams', 'timeInPowerZones']);
const MAX_ARRAY = 24;

// Several windows subscribe to the same channel (every engine window to athlete/watching,
// the field and the rivals strip to nearby); one window per channel writes it. A window
// takes a channel when nobody has written it for OWNER_STALE_MS.
const OWNER_KEY = '/zg-tt/recorder-owner';
const OWNER_STALE_MS = 6000;
const OWNER_REFRESH_MS = 2000;
const ownerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ownerSeen = {};

let control = storage?.get(CONTROL_KEY) || {enabled: false, startedAt: null};
let keep = storage?.get(KEEP_KEY) || {enabled: false};
let dbPromise = null;
let lastNearbyMs = 0;
let writes = 0;
let prunes = 0;

storage?.addEventListener('globalupdate', ev => {
    if (ev?.data?.key === CONTROL_KEY) {
        control = ev.data.value || {enabled: false, startedAt: null};
    } else if (ev?.data?.key === KEEP_KEY) {
        keep = ev.data.value || {enabled: false};
    }
});

export function isEnabled() {
    return Boolean(control?.enabled);
}

export function isKeeping() {
    return Boolean(keep?.enabled);
}

/** Recording at all: either switch. */
export function isActive() {
    return isEnabled() || isKeeping();
}

export function startedAt() {
    return Number(control?.startedAt) || null;
}

// Settings page: on starts a fresh recording, off keeps what was recorded for export. With
// race keeping on, the buffer is the races' too: turning this on then clears only what no
// race needs.
export async function setEnabled(enabled) {
    if (enabled) {
        await clear({keepRaces: isKeeping()});
    }
    control = enabled ? {enabled: true, startedAt: Date.now()} : {...control, enabled: false};
    storage.set(CONTROL_KEY, control);
}

export function setKeeping(enabled) {
    keep = {enabled: Boolean(enabled)};
    storage.set(KEEP_KEY, keep);
}

// owner: the channel whose writer writes this one (the mod's view and log go together).
export async function record(channel, data, {owner = channel} = {}) {
    if (!isActive()) {
        return;
    }
    const now = Date.now();
    if (channel !== 'rpc' && !ownsChannel(owner, now)) {
        return;
    }
    if (channel === 'nearby') {
        if (now - lastNearbyMs < NEARBY_PERIOD_MS) {
            return;
        }
        lastNearbyMs = now;
    }
    // The whole tick while Record telemetry is on; the slim one when only races are kept.
    const d = isEnabled() ? trim(channel, data) : channel === 'athlete/watching' ? slimTick(data) : trim(channel, data);
    const row = {at: now, ch: channel, d, bytes: JSON.stringify(d).length};
    try {
        const db = await openDb();
        await request(db.transaction(STORE, 'readwrite').objectStore(STORE).add(row));
    } catch (err) {
        console.warn('[recorder] write failed', err);
        return;
    }
    if (++writes % PRUNE_EVERY === 0) {
        prune().catch(() => {});
    }
}

function ownsChannel(channel, now) {
    const owners = storage?.get(OWNER_KEY) || {};
    const o = owners[channel];
    if (o && o.id !== ownerId && now - o.at < OWNER_STALE_MS) {
        return false;
    }
    if (!o || o.id !== ownerId || now - (ownerSeen[channel] ?? 0) >= OWNER_REFRESH_MS) {
        ownerSeen[channel] = now;
        storage?.set(OWNER_KEY, {...owners, [channel]: {id: ownerId, at: now}});
    }
    return true;
}

/** This window writes the channel now (the one that saves the races writes the ticks). */
export function writesChannel(channel, now = Date.now()) {
    const o = (storage?.get(OWNER_KEY) || {})[channel];
    return Boolean(o && o.id === ownerId && now - o.at < OWNER_STALE_MS);
}

export async function stats() {
    const db = await openDb();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const index = store.index('at');
    const [rows, first, last] = await Promise.all([
        request(store.count()),
        request(index.openCursor(null, 'next')).then(c => c?.value?.at ?? null),
        request(index.openCursor(null, 'prev')).then(c => c?.value?.at ?? null),
    ]);
    return {
        rows,
        firstAt: first,
        lastAt: last,
        enabled: isEnabled(),
        keeping: isKeeping(),
        startedAt: startedAt(),
    };
}

/** The buffer as JSONL (Save recording) since the recording started, t counted from then. */
export async function exportJsonl() {
    const rows = await rowsBetween(startedAt(), null);
    const t0 = startedAt() ?? rows[0]?.at ?? Date.now();
    const meta = {recorder: 'zwiftgopher-tt', version: VERSION, startedAt: t0, exportedAt: Date.now(), rows: rows.length, userAgent: navigator.userAgent};
    return jsonlParts(rows, t0, meta).join('');
}

function jsonlParts(rows, t0, meta) {
    const parts = [JSON.stringify({t: 0, ch: 'meta', d: meta}) + '\n'];
    for (const r of rows) {
        parts.push(JSON.stringify({t: Math.max(0, r.at - t0), ch: r.ch, d: r.d}) + '\n');
    }
    return parts;
}

/** Clears the buffer; keepRaces leaves what a race not yet saved still needs. */
export async function clear({keepRaces = false} = {}) {
    const db = await openDb();
    const from = keepRaces ? keepFrom(storage?.get(MARKS_KEY)) : null;
    if (from == null) {
        await request(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
    } else {
        await deleteBefore(db, from);
    }
}

export function saveAs(filename, data) {
    const blob = data instanceof Blob ? data : new Blob([data], {type: 'application/x-ndjson'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function trim(channel, data) {
    if (channel === 'athlete/watching') {
        return trimObject(data, 0);
    }
    if (channel === 'nearby') {
        const list = Array.isArray(data) ? data : [];
        const me = list.find(e => e?.watching);
        const subgroup = me?.state?.eventSubgroupId;
        return list
            .filter(e => e && (!subgroup || e.state?.eventSubgroupId === subgroup))
            .map(trimNearbyEntry);
    }
    return data;
}

function trimObject(value, depth) {
    if (Array.isArray(value)) {
        return value.length > MAX_ARRAY ? [] : value.map(v => trimObject(v, depth + 1));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (depth === 0 && WATCHING_DROP.has(k)) {
                continue;
            }
            out[k] = trimObject(v, depth + 1);
        }
        return out;
    }
    return value;
}

function trimNearbyEntry(e) {
    const a = e.athlete || {};
    const s = e.state || {};
    const st = e.stats || {};
    return {
        athleteId: e.athleteId,
        watching: e.watching,
        self: e.self,
        age: e.age,
        athlete: {
            id: a.id, fullname: a.fullname, sanitizedFullname: a.sanitizedFullname, team: a.team,
            weight: a.weight, ftp: a.ftp, cp: a.cp, wPrime: a.wPrime, type: a.type, gender: a.gender,
        },
        state: {
            distance: s.distance, eventDistance: s.eventDistance, time: s.time, speed: s.speed,
            power: s.power, cadence: s.cadence, heartrate: s.heartrate, grade: s.grade,
            eventSubgroupId: s.eventSubgroupId, courseId: s.courseId, routeId: s.routeId,
            laps: s.laps, roadId: s.roadId, roadTime: s.roadTime, progress: s.progress,
            worldTime: s.worldTime,
        },
        stats: {
            power: {avg: st.power?.avg, np: st.power?.np, cur: st.power?.cur},
            speed: {avg: st.speed?.avg},
            hr: {avg: st.hr?.avg},
            elapsed: st.elapsed, activeTime: st.activeTime, distance: st.distance,
        },
        wBal: e.wBal,
        eventPosition: e.eventPosition,
        eventParticipants: e.eventParticipants,
        gap: e.gap, gapDistance: e.gapDistance, isGapEst: e.isGapEst,
        remaining: e.remaining, remainingMetric: e.remainingMetric,
        remainingType: e.remainingType, remainingEnd: e.remainingEnd,
    };
}

// The buffer keeps two hours, and what a race not yet saved needs (its marks), however old: a
// race Sauce was closed during is saved when Sauce next starts. Past MAX_USAGE_BYTES for the
// whole store it keeps 30 minutes (and the races' needs) instead.
async function prune() {
    const db = await openDb();
    const now = Date.now();
    let age = MAX_AGE_MS;
    if (++prunes % 10 === 1 && navigator.storage?.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        if (est?.usage > MAX_USAGE_BYTES) {
            age = SHORT_AGE_MS;
        }
    }
    const need = keepFrom(storage?.get(MARKS_KEY));
    await deleteBefore(db, need == null ? now - age : Math.min(now - age, need));
}

async function deleteBefore(db, at) {
    const index = db.transaction(STORE, 'readwrite').objectStore(STORE).index('at');
    await new Promise((resolve, reject) => {
        const req = index.openCursor(IDBKeyRange.upperBound(at, true));
        req.onsuccess = () => {
            const c = req.result;
            if (!c) {
                resolve();
                return;
            }
            c.delete();
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

/** Rows written between fromAt and toAt (unix ms, null: no bound), oldest first. */
async function rowsBetween(fromAt, toAt) {
    const db = await openDb();
    const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('at');
    const range = fromAt == null && toAt == null ? null
        : fromAt == null ? IDBKeyRange.upperBound(toAt)
            : toAt == null ? IDBKeyRange.lowerBound(fromAt)
                : IDBKeyRange.bound(fromAt, toAt);
    return request(index.getAll(range));
}

// ---- the races kept (race-keeper.mjs) ----

/**
 * Cuts a race out of the buffer (raceWindow), compresses it and keeps it under the race's key.
 * Returns the kept race's summary, or null when the buffer has nothing of it.
 */
export async function saveRace(mark) {
    const {fromAt, toAt} = raceWindow(mark);
    const rows = await rowsBetween(fromAt, toAt);
    const watching = rows.filter(r => r.ch === 'athlete/watching').length;
    if (!watching) {
        return null;
    }
    const meta = {
        recorder: 'zwiftgopher-tt', kind: 'race', version: VERSION, startedAt: rows[0].at, exportedAt: Date.now(),
        rows: rows.length, race: {...mark}, userAgent: navigator.userAgent,
    };
    const parts = jsonlParts(rows, rows[0].at, meta);
    const blob = await gzip(new Blob(parts, {type: 'application/x-ndjson'}));
    const race = {
        key: String(mark.key),
        name: mark.name ?? null,
        code: mark.code ?? null,
        routeId: mark.routeId ?? null,
        subgroupId: mark.subgroupId ?? mark.key,
        joinedAt: mark.joinedAt ?? null,
        startAt: mark.startAt ?? null,
        finishAt: mark.finishAt ?? null,
        timeS: mark.timeS ?? null,
        fromAt,
        toAt: rows[rows.length - 1].at,
        rows: rows.length,
        savedAt: Date.now(),
        bytes: blob.size,
        blob,
    };
    const db = await openDb();
    await request(db.transaction(RACES, 'readwrite').objectStore(RACES).put(race));
    const {blob: _, ...summary} = race;
    return summary;
}

/** The kept races, newest first, without their data. */
export async function listRaces() {
    const db = await openDb();
    const all = await request(db.transaction(RACES, 'readonly').objectStore(RACES).getAll());
    return all.map(({blob, ...r}) => r).sort((a, b) => (b.startAt ?? b.savedAt) - (a.startAt ?? a.savedAt));
}

/** A kept race's compressed file (.jsonl.gz), or null. */
export async function raceBlob(key) {
    const db = await openDb();
    const race = await request(db.transaction(RACES, 'readonly').objectStore(RACES).get(String(key)));
    return race?.blob ?? null;
}

/** A kept race as JSONL text (?replay=race-<key>). */
export async function raceJsonl(key) {
    const blob = await raceBlob(key);
    if (!blob) {
        throw new Error(`no kept race ${key}`);
    }
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export async function deleteRace(key) {
    const db = await openDb();
    await request(db.transaction(RACES, 'readwrite').objectStore(RACES).delete(String(key)));
}

/** Deletes the kept races past their fortnight (or past the space they may take). */
export async function expireRaces(nowMs = Date.now()) {
    const keys = racesToExpire(await listRaces(), nowMs);
    for (const key of keys) {
        await deleteRace(key);
    }
    return keys;
}

async function gzip(blob) {
    return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = ev => {
                const db = req.result;
                // Version 1 rows counted from the recording's start, with no unix time: they go.
                if (ev.oldVersion < 2 && db.objectStoreNames.contains(STORE)) {
                    db.deleteObjectStore(STORE);
                }
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true}).createIndex('at', 'at');
                }
                if (!db.objectStoreNames.contains(RACES)) {
                    db.createObjectStore(RACES, {keyPath: 'key'});
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    return dbPromise;
}

function request(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
