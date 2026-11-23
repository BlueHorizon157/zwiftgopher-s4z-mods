// Race recordings kept for a fortnight (Settings → Advanced → Keep race recordings).
//
// Dave, 2026-11-22, after a Seafoam Circuit TT with the recorder off: "I don't want to have to
// remember to turn it on and then save at the end ... auto clear after a week or something".
// With this on, the recorder (recorder.mjs) runs all the time on slim ticks, every window notes
// the events the rider rides in shared marks, and when a race is over (two minutes after the
// finish, or after leaving the event, or when Sauce was closed during it) the window that writes
// the recording cuts that race out of it: from ten minutes before joining the event to two minutes
// after the end, compressed. Saved races are listed in Settings, kept fourteen days, and saved to a
// file only when the rider wants to report something. Off by default: a rider who never reports a
// problem never needs it.
//
// Everything here is pure (no storage, no IndexedDB, no timers), so node's tests run it; the
// recorder and the runtime do the rest.

export const KEEP_KEY = '/zg-tt/race-keeper';     // {enabled}
export const MARKS_KEY = '/zg-tt/race-marks';     // {[key]: mark}

export const LEAD_MS = 10 * 60 * 1000;            // kept before joining the event (the warm-up, the join)
export const TAIL_MS = 2 * 60 * 1000;             // kept after the finish or leaving
export const STALE_MS = 15 * 60 * 1000;           // a race not seen this long ended unseen (Sauce closed)
export const MAX_RACE_MS = 4 * 3600 * 1000;       // the longest stretch kept from the start
export const SEEN_EVERY_MS = 60 * 1000;           // how often a window says the race is still on
export const LATE_JOIN_MS = 10 * 1000;            // ticks this soon after joining may still be the free ride's
export const MIN_RACE_MS = 2 * 60 * 1000;         // shorter: not kept
export const KEEP_DAYS = 14;
export const KEEP_MAX_BYTES = 300 * 1024 * 1024;  // the saved races together (oldest go first)
export const MARK_FORGET_MS = 24 * 3600 * 1000;   // a saved or dropped mark is forgotten after this

/** The subgroup of a tick, or null (Zwift reports no event as 0 or nothing). */
export function subgroupOfTick(tick) {
    const sg = tick?.state?.eventSubgroupId ?? tick?.eventSubgroupId;
    return sg ? String(sg) : null;
}

/**
 * One window's view of one tick. local is this window's memory ({sg, joinedAt, penSeen,
 * started, finished, seenAt}, null at first); the result is the new memory and the patches for
 * the shared marks (mergeMark). A race starts on Zwift's event timer (after the pen, or 10 s
 * after joining when the pen was missed: the first ticks after a join can still be the free
 * ride's) or when the engine starts racing; it finishes when the event's distance to go reaches
 * zero or the engine says finished; it ends when the rider leaves the event.
 *
 * info: {engineStatus, raceS (the race time at the finish), name (the event), code (the plan),
 * routeId}.
 */
export function observeTick(local, tick, nowMs, info = {}) {
    const patches = [];
    const sg = subgroupOfTick(tick);
    let mem = local ?? {sg: null};
    if (mem.sg && mem.sg !== sg) {
        patches.push({key: mem.sg, leftAt: nowMs, seenAt: nowMs});
        mem = {sg: null};
    }
    if (!sg) {
        return {local: mem, patches};
    }
    const s = tick.state ?? {};
    if (mem.sg !== sg) {
        mem = {sg, joinedAt: nowMs, penSeen: false, started: false, finished: false, seenAt: nowMs};
        patches.push({key: sg, subgroupId: sg, joinedAt: nowMs, seenAt: nowMs});
    }
    const patch = {};
    const timerS = Number(s.time) || 0;
    const ed = Number(s.eventDistance) || 0;
    if (timerS === 0 && ed === 0) {
        mem = {...mem, penSeen: true};
    }
    const eventType = tick.remainingType === 'event';
    const settled = mem.penSeen || nowMs - mem.joinedAt >= LATE_JOIN_MS;
    if (!mem.started && ((settled && eventType && timerS > 0) || info.engineStatus === 'racing')) {
        mem = {...mem, started: true};
        patch.startAt = nowMs;
    }
    const remaining = Number(tick.remaining);
    if (mem.started && !mem.finished && ((eventType && ed > 0 && Number.isFinite(remaining) && remaining <= 0) || info.engineStatus === 'finished')) {
        mem = {...mem, finished: true};
        patch.finishAt = nowMs;
        if (Number.isFinite(info.raceS)) {
            patch.timeS = info.raceS;
        } else if (timerS > 0) {
            patch.timeS = timerS;
        }
    }
    if (info.name && !mem.name) {
        mem = {...mem, name: info.name};
        patch.name = info.name;
    }
    if (info.code && mem.code !== info.code) {
        mem = {...mem, code: info.code};
        patch.code = info.code;
    }
    const routeId = info.routeId ?? s.routeId;
    if (routeId && !mem.routeId) {
        mem = {...mem, routeId: String(routeId)};
        patch.routeId = String(routeId);
    }
    if (Object.keys(patch).length || nowMs - mem.seenAt >= SEEN_EVERY_MS) {
        mem = {...mem, seenAt: nowMs};
        patches.push({key: sg, ...patch, seenAt: nowMs});
    }
    return {local: mem, patches};
}

const earliest = (a, b) => a == null ? (b ?? null) : b == null ? a : Math.min(a, b);
const latest = (a, b) => a == null ? (b ?? null) : b == null ? a : Math.max(a, b);

/**
 * Two windows' notes of the same race, in either order, give the same mark: the earliest join,
 * start, finish and leaving, the latest sighting, the first name, a plan code (the latest seen).
 */
export function mergeMark(a, b) {
    if (!a) {
        return {...b};
    }
    if (!b) {
        return {...a};
    }
    return {
        ...a,
        ...b,
        key: a.key ?? b.key,
        subgroupId: a.subgroupId ?? b.subgroupId ?? a.key ?? b.key,
        joinedAt: earliest(a.joinedAt, b.joinedAt),
        startAt: earliest(a.startAt, b.startAt),
        finishAt: earliest(a.finishAt, b.finishAt),
        leftAt: earliest(a.leftAt, b.leftAt),
        seenAt: latest(a.seenAt, b.seenAt),
        timeS: a.timeS ?? b.timeS ?? null,
        name: a.name ?? b.name ?? null,
        routeId: a.routeId ?? b.routeId ?? null,
        code: b.code ?? a.code ?? null,
        doneAt: earliest(a.doneAt, b.doneAt),
    };
}

/** The shared marks with these patches merged in (a new object; null when nothing changed). */
export function applyPatches(marks, patches) {
    if (!patches?.length) {
        return null;
    }
    const out = {...(marks ?? {})};
    for (const p of patches) {
        out[p.key] = mergeMark(out[p.key], p);
    }
    return out;
}

/** Where a race ends: the finish, else leaving the event, else the last sighting. */
export function endOf(mark) {
    return mark.finishAt ?? mark.leftAt ?? mark.seenAt ?? mark.startAt ?? null;
}

/** The stretch of recording a race keeps: [fromAt, toAt] in unix ms. */
export function raceWindow(mark) {
    const fromAt = (mark.joinedAt ?? mark.startAt) - LEAD_MS;
    const toAt = Math.min(endOf(mark) + TAIL_MS, mark.startAt + MAX_RACE_MS);
    return {fromAt, toAt};
}

/**
 * What to do with each mark now: 'save' (the race is over), 'drop' (no race to keep: never
 * started, too short, or gone without a start), 'forget' (saved or dropped a day ago) or nothing.
 * A mark still running is left alone. Returns {save: [mark], drop: [key], forget: [key]}.
 */
export function marksDue(marks, nowMs) {
    const out = {save: [], drop: [], forget: []};
    for (const mark of Object.values(marks ?? {})) {
        if (!mark?.key) {
            continue;
        }
        if (mark.doneAt != null) {
            if (nowMs - mark.doneAt >= MARK_FORGET_MS && nowMs - (mark.seenAt ?? 0) >= MARK_FORGET_MS) {
                out.forget.push(mark.key);
            }
            continue;
        }
        const gone = nowMs - (mark.seenAt ?? 0) >= STALE_MS;
        const over = (mark.finishAt != null && nowMs >= mark.finishAt + TAIL_MS)
            || (mark.leftAt != null && nowMs >= mark.leftAt + TAIL_MS)
            || gone
            || (mark.startAt != null && nowMs - mark.startAt >= MAX_RACE_MS);
        if (!over) {
            continue;
        }
        if (mark.startAt == null || endOf(mark) - mark.startAt < MIN_RACE_MS) {
            out.drop.push(mark.key);
        } else {
            out.save.push(mark);
        }
    }
    return out;
}

/**
 * The saved races to delete: older than KEEP_DAYS, then the oldest until the rest fit in
 * KEEP_MAX_BYTES. races: [{key, savedAt, bytes}].
 */
export function racesToExpire(races, nowMs, {days = KEEP_DAYS, maxBytes = KEEP_MAX_BYTES} = {}) {
    const keep = [];
    const out = [];
    for (const r of races ?? []) {
        if (nowMs - (r.savedAt ?? 0) > days * 86400000) {
            out.push(r.key);
        } else {
            keep.push(r);
        }
    }
    keep.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    let bytes = 0;
    for (const r of keep) {
        bytes += r.bytes ?? 0;
        if (bytes > maxBytes) {
            out.push(r.key);
        }
    }
    return out;
}

/** The earliest moment of recording a race not yet saved needs (the recorder keeps it), or null. */
export function keepFrom(marks) {
    let from = null;
    for (const mark of Object.values(marks ?? {})) {
        if (mark?.doneAt == null && (mark?.joinedAt ?? mark?.startAt) != null) {
            from = earliest(from, (mark.joinedAt ?? mark.startAt) - LEAD_MS);
        }
    }
    return from;
}

// A watching tick as kept: what the mod's windows read (the engine reads the whole state, the
// event's distance to go and position, the rider; the field and rivals take 'nearby'), the mod's
// own live state (zgtt), and none of Sauce's statistics (stats, lap: 6 of the 11 KB of a tick).
const TICK_DROP = new Set(['stats', 'lap', 'lastLap', 'segmentData', 'laps', 'segments', 'events', 'streams', 'timeInPowerZones']);
const ATHLETE_KEEP = ['id', 'name', 'fullname', 'sanitizedFullname', 'firstName', 'lastName', 'team', 'weight', 'height', 'ftp', 'cp', 'wPrime', 'gender', 'type', 'age'];
const STATE_DROP = new Set(['playerVFXs']);

export function slimTick(data) {
    if (!data || typeof data !== 'object') {
        return data;
    }
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        if (TICK_DROP.has(k)) {
            continue;
        }
        if (k === 'athlete' && v && typeof v === 'object') {
            const a = {};
            for (const f of ATHLETE_KEEP) {
                if (v[f] !== undefined) {
                    a[f] = v[f];
                }
            }
            out.athlete = a;
        } else if (k === 'state' && v && typeof v === 'object') {
            const st = {};
            for (const [sk, sv] of Object.entries(v)) {
                if (!STATE_DROP.has(sk)) {
                    st[sk] = sv;
                }
            }
            out.state = st;
        } else {
            out[k] = v;
        }
    }
    return out;
}

/** The mod's own view of the race once a second, for the recording (the engine's view()). */
export function viewSnapshot(v, extra = {}) {
    if (!v) {
        return null;
    }
    const r = v.race ?? {};
    return {
        status: v.status,
        code: v.plan?.code ?? null,
        card: v.plan?.card ?? null,
        planM: r.planM ?? null,
        lineM: v.event?.lineM ?? null,
        finishM: r.finishM ?? null,
        signal: r.signal ?? null,
        elapsedS: r.elapsedS ?? null,
        deltaS: r.deltaS ?? null,
        totalS: r.totalS ?? null,
        remainingS: r.remainingS ?? null,
        number: v.target?.number ?? null,
        targetW: v.target?.powerW ?? null,
        nextInS: v.next?.inS ?? null,
        wbalKj: v.wbal?.kj ?? null,
        outOfStepM: r.alignment?.outOfStepM ?? null,
        ...extra,
    };
}

/** A saved race's file name: zg-tt-race-2026-11-22-1822-seafoam-circuit.jsonl.gz (local time). */
export function raceFileName(race) {
    const d = new Date(race.startAt ?? race.savedAt ?? 0);
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const slug = String(race.name ?? race.key ?? 'race').toLowerCase()
        .replace(/^stage \d+\s*-\s*/, '').replace(/^zwift tt\s*-\s*/, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'race';
    return `zg-tt-race-${stamp}-${slug}.jsonl.gz`;
}
