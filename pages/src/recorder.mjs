// Telemetry recorder (docs/REVAMP_PLAN.md Phase 0.2).
//
// Keeps the last two hours of the channels a window records through sauce.subscribe()
// ('athlete/watching' from the dashboard, 'nearby' from the field window, RPC results from
// sauce.rpc), trimmed, in IndexedDB, which every window of the mod shares. The settings
// page turns it on and saves the recording as JSONL for test fixtures and ?replay=.
// Control is the global storage key /zg-tt/recorder = {enabled, startedAt}; turning it on
// starts a fresh recording.
import * as common from '/pages/src/common.mjs';
import {VERSION} from './version.mjs';

export const CONTROL_KEY = '/zg-tt/recorder';
const DB_NAME = 'zg-tt-recorder';
const STORE = 'ticks';
const MAX_AGE_MS = 2 * 3600 * 1000;
const MAX_BYTES = 150 * 1024 * 1024;
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

let control = common.storage?.get(CONTROL_KEY) || {enabled: false, startedAt: null};
let dbPromise = null;
let lastNearbyMs = 0;
let writes = 0;

common.storage?.addEventListener('globalupdate', ev => {
    if (ev?.data?.key === CONTROL_KEY) {
        control = ev.data.value || {enabled: false, startedAt: null};
    }
});

export function isEnabled() {
    return Boolean(control?.enabled);
}

export function startedAt() {
    return Number(control?.startedAt) || null;
}

// Settings page: on starts a fresh recording, off keeps what was recorded for export.
export async function setEnabled(enabled) {
    if (enabled) {
        await clear();
    }
    control = enabled ? {enabled: true, startedAt: Date.now()} : {...control, enabled: false};
    common.storage.set(CONTROL_KEY, control);
}

export async function record(channel, data) {
    if (!control?.enabled) {
        return;
    }
    const now = Date.now();
    if (channel !== 'rpc' && !ownsChannel(channel, now)) {
        return;
    }
    if (channel === 'nearby') {
        if (now - lastNearbyMs < NEARBY_PERIOD_MS) {
            return;
        }
        lastNearbyMs = now;
    }
    const d = trim(channel, data);
    const row = {t: now - (Number(control.startedAt) || now), ch: channel, d, bytes: JSON.stringify(d).length};
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
    const owners = common.storage?.get(OWNER_KEY) || {};
    const o = owners[channel];
    if (o && o.id !== ownerId && now - o.at < OWNER_STALE_MS) {
        return false;
    }
    if (!o || o.id !== ownerId || now - (ownerSeen[channel] ?? 0) >= OWNER_REFRESH_MS) {
        ownerSeen[channel] = now;
        common.storage?.set(OWNER_KEY, {...owners, [channel]: {id: ownerId, at: now}});
    }
    return true;
}

export async function stats() {
    const rows = await allRows();
    let bytes = 0;
    for (const r of rows) {
        bytes += r.bytes || 0;
    }
    const ts = rows.map(r => r.t);
    return {
        rows: rows.length,
        bytes,
        firstT: ts.length ? Math.min(...ts) : null,
        lastT: ts.length ? Math.max(...ts) : null,
        enabled: isEnabled(),
        startedAt: startedAt(),
    };
}

export async function exportJsonl() {
    const rows = (await allRows()).sort((a, b) => a.t - b.t);
    const meta = {
        t: 0,
        ch: 'meta',
        d: {
            recorder: 'zwiftgopher-tt',
            version: VERSION,
            startedAt: startedAt(),
            exportedAt: Date.now(),
            rows: rows.length,
            userAgent: navigator.userAgent,
        },
    };
    return [meta, ...rows.map(r => ({t: r.t, ch: r.ch, d: r.d}))].map(r => JSON.stringify(r)).join('\n') + '\n';
}

export async function clear() {
    const db = await openDb();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
}

export function saveAs(filename, text) {
    const blob = new Blob([text], {type: 'application/x-ndjson'});
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

async function prune() {
    const db = await openDb();
    const rows = await allRows();
    const newest = rows.reduce((m, r) => Math.max(m, r.t), 0);
    let bytes = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    for (const row of rows.sort((a, b) => a.t - b.t)) {
        if (newest - row.t <= MAX_AGE_MS && bytes <= MAX_BYTES) {
            break;
        }
        await request(store.delete(row.id));
        bytes -= row.bytes || 0;
    }
}

async function allRows() {
    const db = await openDb();
    return request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
}

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(STORE, {keyPath: 'id', autoIncrement: true});
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
