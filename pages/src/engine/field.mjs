// The riders around you (docs/REVAMP_PLAN.md 4.5, Phase 4.2 and 4.4). Pure: Sauce's
// `nearby` list goes in with the time, rows come out; no DOM, storage or timers.
//
// Every rider gets a checkpoint every 50 m of event distance holding the world time they
// passed it (interpolated between samples). Two riders compared at the same checkpoint give:
//   road gap   how long ago the rider ahead passed the point the trailing rider is at now
//              (who is physically ahead, and by how much);
//   clock gap  the same on each rider's own race clock (who is faster in the standings: in
//              a TT riders start apart, so a rider behind on the road can be ahead on time).
// Both are measured at the trailing rider's latest checkpoint, so they are always fresh. The
// trend is the change of the gap over the trailing rider's last 60 s; the clock gap and the
// road gap differ by a constant (the start offset), so they share it. A sector speed is each
// rider's average speed over the last complete plan interval (1 km sections without a plan).

export const FIELD_DEFAULTS = {
    spacingM: 50,
    staleMs: 120_000,          // unseen this long: faded
    evictMs: 600_000,          // unseen this long: gone
    trendWindowS: 60,
    minTrendS: 20,             // less history than this: no trend yet
    holdSPerMin: 0.15,         // |trend| under this is "holding"
    minSectorM: 400,           // shorter plan intervals are merged backwards for sector speeds
    gridSectorM: 1000,
    maxM: 250_000,
};

export function createField(opts = {}) {
    return {opts: {...FIELD_DEFAULTS, ...opts}, riders: new Map(), homeId: null, subgroupId: null, lastMs: null};
}

export function resetField(field) {
    field.riders.clear();
    field.homeId = null;
    field.subgroupId = null;
}

const idOf = e => {
    const id = e?.athleteId ?? e?.athlete?.id;
    return id == null ? null : String(id);
};
const num = v => (v == null || v === '' ? NaN : Number(v));

function newRider(id) {
    return {
        id, name: null, team: null, weightKg: null, wPrimeJ: null, wbalJ: null,
        avgKmh: null, avgPowerW: null, speedKmh: null, powerW: null,
        subgroupId: null, position: null, participants: null,
        distanceM: null, lastSeenMs: null,
        cp: new Float64Array(64).fill(NaN), lastK: 0, lastM: null, lastWT: null, arrivedWT: null, prev: null, settled: false,
        startWT: null, startSource: null,
    };
}

function clearTrack(r) {
    r.cp = new Float64Array(64).fill(NaN);
    r.lastK = 0;
    r.lastM = null;
    r.lastWT = null;
    r.arrivedWT = null;
    r.prev = null;
    r.settled = false;
    r.startWT = null;
    r.startSource = null;
}

function setCheckpoint(r, k, wt) {
    if (k >= r.cp.length) {
        let size = r.cp.length;
        while (size <= k) {
            size *= 2;
        }
        const next = new Float64Array(size).fill(NaN);
        next.set(r.cp);
        r.cp = next;
    }
    if (Number.isNaN(r.cp[k])) {
        r.cp[k] = wt;
    }
    if (k > r.lastK) {
        r.lastK = k;
    }
}

/**
 * One `nearby` list. ctx: {lineM} the timing line in event metres (TT clock start),
 * {kind} 'tt' | 'group' | null, {gunMs} a group event's start (world ms).
 */
export function ingest(field, entries, nowMs, {lineM = null, kind = null, gunMs = null} = {}) {
    const o = field.opts;
    const list = Array.isArray(entries) ? entries : [];
    const home = list.find(e => e?.watching) ?? null;
    field.homeId = home ? idOf(home) : field.homeId;
    field.subgroupId = home ? (home.state?.eventSubgroupId ?? null) : field.subgroupId;
    for (const e of list) {
        const id = idOf(e);
        if (!id) {
            continue;
        }
        let r = field.riders.get(id);
        if (!r) {
            r = newRider(id);
            field.riders.set(id, r);
        }
        const s = e.state ?? {};
        const a = e.athlete ?? {};
        const st = e.stats ?? {};
        const subgroupId = s.eventSubgroupId ?? null;
        if (r.subgroupId != null && subgroupId !== r.subgroupId) {
            clearTrack(r);
        }
        r.subgroupId = subgroupId;
        r.name = a.sanitizedFullname || a.fullname || r.name;
        r.team = a.team || null;
        r.weightKg = num(a.weight) > 0 ? num(a.weight) : r.weightKg;
        r.wPrimeJ = num(a.wPrime) > 0 ? num(a.wPrime) : r.wPrimeJ;
        r.wbalJ = Number.isFinite(num(e.wBal)) ? num(e.wBal) : null;
        r.avgKmh = Number.isFinite(num(st.speed?.avg)) ? num(st.speed.avg) : r.avgKmh;
        r.avgPowerW = Number.isFinite(num(st.power?.avg)) ? num(st.power.avg) : r.avgPowerW;
        const prevKmh = r.speedKmh;
        r.speedKmh = Number.isFinite(num(s.speed)) ? num(s.speed) : null;
        r.powerW = Number.isFinite(num(s.power)) ? num(s.power) : null;
        r.position = num(e.eventPosition) > 0 ? num(e.eventPosition) : null;
        r.participants = num(e.eventParticipants) > 0 ? num(e.eventParticipants) : null;
        r.lastSeenMs = nowMs;
        const m = num(s.eventDistance);
        const wt = Number.isFinite(num(s.worldTime)) ? num(s.worldTime) : nowMs;
        if (!Number.isFinite(m) || m < 0) {
            continue;
        }
        r.distanceM = m;
        if (r.lastM != null && m < r.lastM - o.spacingM) {
            clearTrack(r);          // a new event or a rejoin: the distance went back
        }
        if (r.lastM != null && m > r.lastM && wt >= r.lastWT) {
            const dm = m - r.lastM;
            const dt = wt - r.lastWT;
            const k0 = Math.floor(r.lastM / o.spacingM) + 1;
            const k1 = Math.min(Math.floor(m / o.spacingM), Math.floor(o.maxM / o.spacingM));
            for (let k = Math.max(1, k0); k <= k1; k++) {
                setCheckpoint(r, k, r.lastWT + dt * ((k * o.spacingM - r.lastM) / dm));
            }
            // Crossing the line (at the pen, metre 0, a rider leaves it at the last stationary sample).
            if (r.startWT == null && kind !== 'group' && Number.isFinite(lineM) && r.lastM <= lineM && m > lineM) {
                r.startWT = r.lastWT + dt * ((lineM - r.lastM) / dm);
                r.startSource = 'line';
            }
        }
        if (r.startWT == null) {
            if (kind === 'group' && Number.isFinite(gunMs)) {
                r.startWT = gunMs;
                r.startSource = 'gun';
            } else if (Number.isFinite(lineM) && m > lineM && num(s.time) > 0) {
                // First seen past the line: trust the game's timer for this rider's start.
                r.startWT = wt - num(s.time) * 1000;
                r.startSource = 'time';
            }
        }
        // lastWT is the latest time at lastM (a rider leaving the pen leaves at the last
        // stationary sample); arrivedWT the first (a rider who stops at the finish got there then).
        if (r.lastM == null || m > r.lastM) {
            r.prev = r.lastM == null ? null : {m: r.lastM, wt: r.lastWT, kmh: prevKmh};
            r.arrivedWT = wt;
            r.settled = false;
        } else if (m === r.lastM && wt > r.lastWT && !r.settled) {
            settleArrival(field, r);
        }
        if (r.lastM == null || m >= r.lastM) {
            r.lastM = m;
            r.lastWT = wt;
        }
    }
    for (const [id, r] of field.riders) {
        if (nowMs - r.lastSeenMs > o.evictMs && id !== field.homeId) {
            field.riders.delete(id);
        }
    }
    field.lastMs = nowMs;
    return field;
}

/**
 * The rider stopped (the distance did not move between two samples, as at the finish): they
 * got there before the sample that first showed it. Back-date the arrival from the speed they
 * were doing and re-time the checkpoints since the sample before.
 */
function settleArrival(field, r) {
    r.settled = true;
    const p = r.prev;
    if (!p || !(p.kmh > 1) || !Number.isFinite(p.wt)) {
        return;
    }
    const est = p.wt + (r.lastM - p.m) / (p.kmh / 3.6) * 1000;
    if (!(est > p.wt && est < r.arrivedWT)) {
        return;
    }
    r.arrivedWT = est;
    const sp = field.opts.spacingM;
    for (let k = Math.floor(p.m / sp) + 1; k <= Math.floor(r.lastM / sp); k++) {
        if (k >= 1 && k < r.cp.length) {
            r.cp[k] = p.wt + (est - p.wt) * ((k * sp - p.m) / (r.lastM - p.m));
        }
    }
}

/** World time a rider passed metre m, interpolated between checkpoints. */
export function timeAt(field, r, m) {
    const sp = field.opts.spacingM;
    const k0 = Math.floor(m / sp);
    const f = m / sp - k0;
    const t0 = k0 >= 1 ? r.cp[k0] : NaN;
    if (f === 0) {
        return Number.isFinite(t0) ? t0 : null;
    }
    const t1 = r.cp[k0 + 1];
    if (!Number.isFinite(t0)) {
        return null;
    }
    if (Number.isFinite(t1)) {
        return t0 + (t1 - t0) * f;
    }
    // Between the last checkpoint and where the rider is (or stopped): use the arrival there.
    const k0M = k0 * sp;
    if (r.lastM != null && r.lastM >= m && r.lastM > k0M && Number.isFinite(r.arrivedWT)) {
        return t0 + (r.arrivedWT - t0) * ((m - k0M) / (r.lastM - k0M));
    }
    return null;
}

/**
 * The last complete sector a rider at distM has ridden: [start, end] in event metres from
 * the sorted boundaries, merged backwards until it is at least minSectorM long.
 */
export function lastSector(boundaries, distM, minSectorM) {
    const done = boundaries.filter(b => b <= distM);
    if (done.length < 2) {
        return null;
    }
    const end = done[done.length - 1];
    for (let i = done.length - 2; i >= 0; i--) {
        if (end - done[i] >= minSectorM) {
            return {startM: done[i], endM: end};
        }
    }
    return {startM: done[0], endM: end};
}

function gridBoundaries(field, toM) {
    const out = [];
    for (let m = 0; m <= toM; m += field.opts.gridSectorM) {
        out.push(m);
    }
    return out;
}

/**
 * Home against one rider. boundaries: sector boundaries in event metres (plan intervals),
 * or null for the 1 km grid. Positive gaps mean the rider is ahead of home.
 */
export function compare(field, home, r, {boundaries = null} = {}) {
    const o = field.opts;
    if (!home || !r) {
        return null;
    }
    const k = Math.min(home.lastK, r.lastK);
    if (k < 1 || !Number.isFinite(home.cp[k]) || !Number.isFinite(r.cp[k])) {
        return null;
    }
    const gapAt = j => (Number.isFinite(home.cp[j]) && Number.isFinite(r.cp[j]) ? (home.cp[j] - r.cp[j]) / 1000 : null);
    const roadS = gapAt(k);
    const clockS = home.startWT != null && r.startWT != null
        ? roadS - (home.startWT - r.startWT) / 1000
        : null;
    // Trend over the trailing rider's last trendWindowS seconds.
    const trail = home.cp[k] >= r.cp[k] ? home : r;
    let j0 = null;
    for (let j = k - 1; j >= 1; j--) {
        if (gapAt(j) == null) {
            break;
        }
        j0 = j;
        if ((trail.cp[k] - trail.cp[j]) / 1000 >= o.trendWindowS) {
            break;
        }
    }
    let gainSPerMin = null;
    let trendSpanS = 0;
    if (j0 != null) {
        trendSpanS = (trail.cp[k] - trail.cp[j0]) / 1000;
        if (trendSpanS >= o.minTrendS) {
            // The gap growing means the rider ahead is pulling away or the one behind is
            // closing: home loses time either way.
            gainSPerMin = -((roadS - gapAt(j0)) / trendSpanS) * 60;
        }
    }
    const trend = gainSPerMin == null ? null
        : Math.abs(gainSPerMin) < o.holdSPerMin ? 'holding' : gainSPerMin > 0 ? 'gaining' : 'losing';
    // Sector speeds over the last sector both have completed.
    const trailM = Math.min(home.lastM ?? 0, r.lastM ?? 0);
    const bounds = boundaries?.length ? boundaries : gridBoundaries(field, trailM);
    const sec = lastSector(bounds, trailM, o.minSectorM);
    let sector = null;
    if (sec) {
        const startM = Math.max(sec.startM, o.spacingM);
        const speed = rider => {
            const t0 = timeAt(field, rider, startM);
            const t1 = timeAt(field, rider, sec.endM);
            return t0 != null && t1 != null && t1 > t0 ? (sec.endM - startM) / ((t1 - t0) / 1000) * 3.6 : null;
        };
        sector = {startM, endM: sec.endM, homeKmh: speed(home), riderKmh: speed(r)};
    }
    return {roadS, clockS, gainSPerMin, trend, trendSpanS, sector, atM: k * o.spacingM};
}

/**
 * The rows to draw: home and the riders of its subgroup (all riders with allSubgroups),
 * each with its comparison against home, sorted by the chosen gap (riders ahead first).
 */
export function rows(field, {nowMs, allSubgroups = false, boundaries = null, gapMode = 'clock'} = {}) {
    const o = field.opts;
    const home = field.homeId ? field.riders.get(field.homeId) : null;
    const out = [];
    for (const r of field.riders.values()) {
        const isHome = r.id === field.homeId;
        if (!isHome && !allSubgroups && field.subgroupId != null && r.subgroupId !== field.subgroupId) {
            continue;
        }
        const cmp = !isHome && home ? compare(field, home, r, {boundaries}) : null;
        const gapS = cmp ? (gapMode === 'road' ? cmp.roadS : (cmp.clockS ?? cmp.roadS)) : (isHome ? 0 : null);
        out.push({
            id: r.id,
            name: r.name ?? `rider ${r.id}`,
            team: r.team,
            isHome,
            stale: nowMs != null && r.lastSeenMs != null && nowMs - r.lastSeenMs > o.staleMs,
            started: r.lastK >= 1,
            position: r.position,
            participants: r.participants,
            distanceM: r.distanceM,
            gapS,
            gapIsClock: cmp ? gapMode !== 'road' && cmp.clockS != null : null,
            roadS: cmp?.roadS ?? null,
            clockS: cmp?.clockS ?? null,
            gainSPerMin: cmp?.gainSPerMin ?? null,
            trend: cmp?.trend ?? null,
            trendSpanS: cmp?.trendSpanS ?? 0,
            sector: cmp?.sector ?? null,
            avgKmh: r.avgKmh,
            speedKmh: r.speedKmh,
            wkg: r.avgPowerW != null && r.weightKg > 0 ? r.avgPowerW / r.weightKg : null,
            wbalKj: r.wbalJ != null ? r.wbalJ / 1000 : null,
            wbalPct: r.wbalJ != null && r.wPrimeJ > 0 ? r.wbalJ / r.wPrimeJ * 100 : null,
        });
    }
    out.sort((a, b) => sortKey(b) - sortKey(a) || (a.position ?? 1e9) - (b.position ?? 1e9) || (b.distanceM ?? 0) - (a.distanceM ?? 0));
    return out;
}

function sortKey(row) {
    if (row.isHome) {
        return 0;
    }
    return Number.isFinite(row.gapS) ? row.gapS : -1e9;
}

/** The nearest riders ahead and behind on the road, for the rivals strip. */
export function rivals(field, {nowMs, each = 2, boundaries = null} = {}) {
    const list = rows(field, {nowMs, boundaries, gapMode: 'road'}).filter(r => !r.isHome && !r.stale && r.roadS != null);
    const ahead = list.filter(r => r.roadS > 0).sort((a, b) => a.roadS - b.roadS);
    const behind = list.filter(r => r.roadS <= 0).sort((a, b) => b.roadS - a.roadS);
    const home = field.homeId ? field.riders.get(field.homeId) : null;
    return {
        home: home ? {id: home.id, name: home.name, distanceM: home.distanceM, speedKmh: home.speedKmh} : null,
        ahead: ahead.slice(0, each),
        behind: behind.slice(0, each),
        all: list,
    };
}
