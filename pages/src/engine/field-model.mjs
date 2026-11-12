// The riders around you (docs/REVAMP_PLAN.md 4.5, Phase 4.2 and 4.4). Pure: Sauce's `nearby`
// list goes in with the time, rows come out; no DOM, storage or timers.
//
// Every rider gets a checkpoint every 50 m of event distance holding the world time they
// passed it (interpolated between samples). The gap between you and a rider is measured on
// the clock: at the same distance along the course, how much longer you took than they did,
// each on their own race clock (their start at the timing line is taken off). In a TT riders
// start apart, so a rider who is physically behind you can be ahead on the clock; the clock is
// the only position the windows show. The gap is measured at the trailing rider's latest
// checkpoint: fresh while the rider's samples are close together (see the gap note below). The trend is the change of the gap over the trailing
// rider's last 60 s; the pace is the sustained trend: the least-squares slope of the gap over
// the last four minutes (at least 90 s of history), which a sprint barely moves. A sector speed
// is each rider's average speed over the last complete plan interval (1 km sections without a
// plan).
//
// A rider who passes the event's length (the line you finish at) is finished: their finish
// time is their own clock at the line (the world time they crossed it, less their start), and
// their later samples are ignored, so their gaps and pace stop there. Two finished riders are
// compared on their finish times exactly. A finisher is kept whatever the list shows of it
// (never evicted, never 'not seen').
//
// The checkpoints are made from the rider's samples while the world-time gap between two of them
// is at most maxGapS. Across a longer gap (the rider was out of the list) none are made, so the
// checkpoints stop at the last one before the gap until the rider's samples are close again: the
// gap is then measured at that last checkpoint, which can be up to the gap's distance behind the
// rider (about 300 m after a 20 s gap at race speed), and the trend and pace windows stop there.

import {unixToWorldMs} from './clock.mjs';

export const FIELD_DEFAULTS = {
    spacingM: 50,
    staleMs: 120_000,          // unseen this long: not compared (faded, below the divider)
    evictMs: 600_000,          // unseen this long: gone
    trendWindowS: 60,
    minTrendS: 20,             // less history than this: no trend yet
    paceWindowS: 240,          // the sustained trend (pace) for the finish outlook
    minPaceS: 90,              // less shared history than this: no pace
    holdSPerMin: 0.15,         // |trend| under this is "holding"
    finishSeenM: 100,          // first seen this far past the line: its finish time is estimated
    maxGapS: 20,               // no checkpoints across a longer gap in a rider's samples (they left the list)
    minSectorM: 400,           // shorter plan intervals are merged backwards for sector speeds
    gridSectorM: 1000,
    maxM: 250_000,
};

export function createField(opts = {}) {
    return {opts: {...FIELD_DEFAULTS, ...opts}, riders: new Map(), homeId: null, subgroupId: null, lastMs: null, lengthM: null, lengthFor: null};
}

export function resetField(field) {
    field.riders.clear();
    field.homeId = null;
    field.subgroupId = null;
    field.lengthM = null;
    field.lengthFor = null;
}

const idOf = e => {
    const id = e?.athleteId ?? e?.athlete?.id;
    return id == null ? null : String(id);
};
const num = v => (v == null || v === '' ? NaN : Number(v));
// A subgroup of 0 (or none) is no category: a rider who has finished or left reports it so.
const usable = v => v != null && v !== '' && Number(v) !== 0 && Number.isFinite(Number(v));

/** The home rider's entry in a nearby list: the one being watched, else the logged-in rider. */
export function homeEntryOf(list) {
    return list.find(e => e?.watching) ?? list.find(e => e?.self) ?? null;
}

function newRider(id) {
    return {
        id, name: null, team: null, weightKg: null, wPrimeJ: null, wbalJ: null,
        avgKmh: null, avgPowerW: null, speedKmh: null, powerW: null,
        subgroupId: null, position: null, participants: null,
        distanceM: null, lastSeenMs: null,
        cp: new Float64Array(64).fill(NaN), lastK: 0, lastM: null, lastWT: null, arrivedWT: null, prev: null, settled: false,
        startWT: null, startSource: null, startLoWT: null, startHiWT: null,
        finished: false, finishWT: null, finishRaceApproxS: null,
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
    r.startLoWT = null;
    r.startHiWT = null;
    r.finished = false;
    r.finishWT = null;
    r.finishRaceApproxS = null;
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
 * {kind} 'tt' | 'group' | null, {gunMs} a group event's start (Unix ms, as Sauce gives it: it is
 * put on the scale of each sample's world time), {lengthM} the event's length in event metres
 * (the line you finish at; null or absent when not known). A group event with a known start
 * runs every rider's clock from the gun, as its result does; without one each rider's clock
 * starts at the line, as in a TT.
 */
export function ingest(field, entries, nowMs, {lineM = null, kind = null, gunMs = null, lengthM = null} = {}) {
    const o = field.opts;
    const byGun = kind === 'group' && gunMs != null && Number.isFinite(Number(gunMs));
    const list = Array.isArray(entries) ? entries : [];
    const home = homeEntryOf(list);
    field.homeId = home ? idOf(home) : field.homeId;
    // The home rider reports subgroup 0 once it has stopped past the finish: keep its category.
    const category = home && usable(home.state?.eventSubgroupId) ? String(home.state.eventSubgroupId) : null;
    if (category != null) {
        field.subgroupId = home.state.eventSubgroupId;
    }
    // The event's length is the first one seen for its category: once the home rider has left
    // the event, the game reports another length (the ride on), which must not move the line.
    if (Number.isFinite(lengthM) && lengthM > 0 && (field.lengthM == null || (category != null && category !== field.lengthFor))) {
        field.lengthM = lengthM;
        field.lengthFor = category ?? field.lengthFor;
    }
    const L = field.lengthM;
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
        const subgroupId = usable(s.eventSubgroupId) ? s.eventSubgroupId : null;
        if (subgroupId != null) {
            if (r.subgroupId != null && subgroupId !== r.subgroupId) {
                clearTrack(r);
            }
            r.subgroupId = subgroupId;
        }
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
        // A distance that drops to about the line with no category is a rider leaving the event
        // (Sauce reports 0): the race is kept, not cleared. A distance that goes back in the event
        // is a new event or a rejoin.
        const leaving = subgroupId == null && m <= o.spacingM;
        if (r.lastM != null && m < r.lastM - o.spacingM && !leaving) {
            clearTrack(r);
        }
        // Finished: the line is passed, so nothing after it counts for gaps or pace.
        if (r.finished) {
            continue;
        }
        // The game's timer starts at the line (as its distance does), so it places a rider's
        // start: its race time is whole seconds, so each sample past the line bounds the start to
        // a second, and the bounds of all of them narrow it. The crossing below is the fallback
        // for a rider without a timer reading.
        if (!byGun && Number.isFinite(lineM) && m > lineM && Number.isFinite(num(s.time)) && num(s.time) >= 0) {
            const tm = num(s.time);
            const hi = wt - tm * 1000;
            const lo = wt - (tm + 1) * 1000;
            r.startHiWT = r.startHiWT == null ? hi : Math.min(r.startHiWT, hi);
            r.startLoWT = r.startLoWT == null ? lo : Math.max(r.startLoWT, lo);
            r.startWT = r.startLoWT <= r.startHiWT ? (r.startLoWT + r.startHiWT) / 2 : r.startHiWT;
            r.startSource = 'time';
        }
        if (r.lastM != null && m > r.lastM && wt >= r.lastWT) {
            const dm = m - r.lastM;
            const dt = wt - r.lastWT;
            // Checkpoints stop at the line: the line is the finish, so nothing beyond it is kept.
            const mCap = L != null && m > L ? L : m;
            const k0 = Math.floor(r.lastM / o.spacingM) + 1;
            const k1 = Math.min(Math.floor(mCap / o.spacingM), Math.floor(o.maxM / o.spacingM));
            // Between two samples the time is interpolated; across a long gap (the rider was out of
            // the list) it is not known, so no checkpoints are made there.
            if (dt <= o.maxGapS * 1000) {
                for (let k = Math.max(1, k0); k <= k1; k++) {
                    setCheckpoint(r, k, r.lastWT + dt * ((k * o.spacingM - r.lastM) / dm));
                }
            }
            // Crossing the line (at the pen, metre 0, a rider leaves it at the last stationary sample).
            if (r.startWT == null && !byGun && Number.isFinite(lineM) && r.lastM <= lineM && m > lineM) {
                r.startWT = r.lastWT + dt * ((lineM - r.lastM) / dm);
                r.startSource = 'line';
            }
            // Crossing the finish: the world time on the same straight line the checkpoints use,
            // unless the samples either side are too far apart to say when (then no time).
            if (L != null && r.lastM < L && m >= L) {
                if (dt <= o.maxGapS * 1000) {
                    r.finishWT = r.lastWT + dt * ((L - r.lastM) / dm);
                }
                r.finished = true;
            }
        }
        if (r.startWT == null && byGun) {
            r.startWT = unixToWorldMs(gunMs, wt);
            r.startSource = 'gun';
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
        // First seen past the line (no crossing in view): finished. Within a few metres past it
        // (a rider seen just after the line), the finish time is their race time here less the
        // way they rode back to the line at this speed (about, to a second or two); further on,
        // no time is estimated.
        if (!r.finished && L != null && m >= L && (r.lastM == null || r.lastM >= L)) {
            r.finished = true;
            const tm = num(s.time);
            const kmh = num(s.speed);
            if (Number.isFinite(tm) && tm >= 0 && m - L <= o.finishSeenM && kmh > 1) {
                r.finishRaceApproxS = Math.max(0, tm - (m - L) / (kmh / 3.6));
            }
        }
    }
    // Unseen for evictMs: gone, except the home rider and a finisher (its finish place and the
    // finisher count are the field's, and a finisher the list dropped still crossed the line).
    for (const [id, r] of field.riders) {
        if (nowMs - r.lastSeenMs > o.evictMs && id !== field.homeId && !r.finished) {
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
 * The rider's race time at the line they finished (their own clock), or null. From the
 * checkpoints when their crossing was seen; for a rider first seen past the line, estimated from
 * their own race time there (about, to a few seconds).
 */
export function finishRaceOf(r) {
    if (!r?.finished) {
        return null;
    }
    if (Number.isFinite(r.finishWT) && r.startWT != null) {
        return (r.finishWT - r.startWT) / 1000;
    }
    return Number.isFinite(r.finishRaceApproxS) ? r.finishRaceApproxS : null;
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
 * Home against one rider, on the clock. boundaries: sector boundaries in event metres (plan
 * intervals), or null for the 1 km grid. clockS is positive when the rider is ahead of home:
 * at the same distance they had less race time than you. Null when they share no point, or
 * either has no start yet.
 */
export function compare(field, home, r, {boundaries = null} = {}) {
    const o = field.opts;
    if (!home || !r || home.startWT == null || r.startWT == null) {
        return null;
    }
    // The latest distance both have a checkpoint at (the trailing rider's, unless a gap leaves none).
    let k = Math.min(home.lastK, r.lastK);
    for (let steps = 0; k >= 1 && !(Number.isFinite(home.cp[k]) && Number.isFinite(r.cp[k])) && steps < 200; steps++) {
        k--;
    }
    if (k < 1 || !Number.isFinite(home.cp[k]) || !Number.isFinite(r.cp[k])) {
        return null;
    }
    // Each rider's race clock is their world time less their start: the offset takes the start
    // apart, so the gap is the difference of the two race clocks at the same distance.
    const offsetS = (home.startWT - r.startWT) / 1000;
    const clockAt = j => (Number.isFinite(home.cp[j]) && Number.isFinite(r.cp[j]) ? (home.cp[j] - r.cp[j]) / 1000 - offsetS : null);
    const nowAt = clockAt(k);
    // Both finished: their finish times, exactly (the same distance, the line).
    const hf = finishRaceOf(home);
    const rf = finishRaceOf(r);
    const clockS = hf != null && rf != null ? hf - rf : nowAt;
    // Trend over the trailing rider's last trendWindowS seconds.
    const trail = home.cp[k] >= r.cp[k] ? home : r;
    let j0 = null;
    for (let j = k - 1; j >= 1; j--) {
        if (clockAt(j) == null) {
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
            gainSPerMin = -((nowAt - clockAt(j0)) / trendSpanS) * 60;
        }
    }
    const trend = gainSPerMin == null ? null
        : Math.abs(gainSPerMin) < o.holdSPerMin ? 'holding' : gainSPerMin > 0 ? 'gaining' : 'losing';
    // The pace: the slope of the gap against the trailing rider's time over paceWindowS, by
    // least squares over every checkpoint, so one fast minute moves it a quarter as much.
    let paceSPerMin = null;
    let paceSpanS = 0;
    const xs = [];
    const ys = [];
    for (let j = k; j >= 1; j--) {
        const g = clockAt(j);
        if (g == null) {
            break;
        }
        const ageS = (trail.cp[k] - trail.cp[j]) / 1000;
        if (ageS > o.paceWindowS) {
            break;
        }
        xs.push(-ageS);
        ys.push(g);
        paceSpanS = ageS;
    }
    if (paceSpanS >= o.minPaceS && xs.length >= 3) {
        const n = xs.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let sxy = 0;
        let sxx = 0;
        for (let i = 0; i < n; i++) {
            sxy += (xs[i] - mx) * (ys[i] - my);
            sxx += (xs[i] - mx) ** 2;
        }
        if (sxx > 0) {
            paceSPerMin = -(sxy / sxx) * 60;
        }
    }
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
    return {clockS, gainSPerMin, trend, trendSpanS, paceSPerMin, paceSpanS, sector, atM: k * o.spacingM};
}

/**
 * The rows to draw: home and the riders of its subgroup (all riders with allSubgroups), each
 * with its comparison against home on the clock. Comparable riders come first, nearest ahead
 * first, each with its like-for-like place (1 is the rider furthest ahead on the clock, home
 * included); the rest follow, with the reason they cannot be compared yet. Finishers also get
 * their finish place (1 is the first to cross the line, by their own race time).
 */
export function rows(field, {nowMs = null, allSubgroups = false, boundaries = null} = {}) {
    const o = field.opts;
    const home = field.homeId ? field.riders.get(field.homeId) : null;
    const homeStarted = Boolean(home && home.startWT != null && home.lastK >= 1);
    const out = [];
    for (const r of field.riders.values()) {
        const isHome = r.id === field.homeId;
        if (!isHome && !allSubgroups && field.subgroupId != null && r.subgroupId !== field.subgroupId) {
            continue;
        }
        // A finisher is not stale in the sense of the field: its finish time and place stand.
        const stale = nowMs != null && r.lastSeenMs != null && nowMs - r.lastSeenMs > o.staleMs && !r.finished;
        const cmp = !isHome && home ? compare(field, home, r, {boundaries}) : null;
        let reason = null;
        if (isHome) {
            reason = homeStarted ? null : 'not started';
        } else if (stale) {
            reason = 'not seen for two minutes';
        } else if (r.lastK < 1 && r.startWT == null) {
            reason = 'not started';
        } else if (!cmp) {
            reason = 'no shared point yet';
        }
        const comparable = reason == null && (isHome || Boolean(cmp));
        const clockS = isHome ? (homeStarted ? 0 : null) : (cmp?.clockS ?? null);
        out.push({
            id: r.id,
            name: r.name ?? `rider ${r.id}`,
            team: r.team,
            isHome,
            stale,
            started: r.lastK >= 1,
            comparable,
            reason,
            clockS,
            gapS: comparable ? clockS : null,
            place: null,
            finished: r.finished,
            finishRaceS: finishRaceOf(r),
            finishPlace: null,
            finishers: null,
            distanceM: r.distanceM,
            // A finished rider has no more pace or trend: the gap is frozen at the line.
            gainSPerMin: r.finished ? null : (cmp?.gainSPerMin ?? null),
            paceSPerMin: r.finished ? null : (cmp?.paceSPerMin ?? null),
            paceSpanS: r.finished ? 0 : (cmp?.paceSpanS ?? 0),
            trend: r.finished ? null : (cmp?.trend ?? null),
            trendSpanS: r.finished ? 0 : (cmp?.trendSpanS ?? 0),
            sector: cmp?.sector ?? null,
            avgKmh: r.avgKmh,
            speedKmh: r.speedKmh,
            wkg: r.avgPowerW != null && r.weightKg > 0 ? r.avgPowerW / r.weightKg : null,
            wbalKj: r.wbalJ != null ? r.wbalJ / 1000 : null,
            wbalPct: r.wbalJ != null && r.wPrimeJ > 0 ? r.wbalJ / r.wPrimeJ * 100 : null,
        });
    }
    const compared = out.filter(x => x.comparable).sort((a, b) => b.gapS - a.gapS || (b.distanceM ?? 0) - (a.distanceM ?? 0));
    compared.forEach((x, i) => {
        x.place = i + 1;
    });
    const rest = out.filter(x => !x.comparable).sort((a, b) => (b.distanceM ?? 0) - (a.distanceM ?? 0));
    // Finish places: finishers in the order they crossed the line, by their own race times.
    const finishers = out.filter(x => x.finishRaceS != null).sort((a, b) => a.finishRaceS - b.finishRaceS);
    finishers.forEach((x, i) => {
        x.finishPlace = i + 1;
        x.finishers = finishers.length;
    });
    return [...compared, ...rest];
}

/** The home rider's like-for-like place: 1 + the comparable riders ahead on the clock, of all comparable + you. */
export function placeOf(list) {
    const home = list.find(r => r.isHome) ?? null;
    if (!home?.comparable) {
        return {place: null, of: null};
    }
    const cmp = list.filter(r => r.comparable);
    return {place: 1 + cmp.filter(r => !r.isHome && r.gapS > 0).length, of: cmp.length};
}

/** The nearest riders ahead and behind on the clock, for the rivals strip (rows() output). */
export function rivalsOf(list, {each = 2} = {}) {
    const all = list.filter(r => !r.isHome && r.comparable && Number.isFinite(r.gapS));
    const ahead = all.filter(r => r.gapS > 0).sort((a, b) => a.gapS - b.gapS);
    const behind = all.filter(r => r.gapS <= 0).sort((a, b) => b.gapS - a.gapS);
    return {
        home: list.find(r => r.isHome) ?? null,
        ahead: ahead.slice(0, each),
        behind: behind.slice(0, each),
        all,
    };
}

/** rivalsOf over the field: rows() then the nearest each side. */
export function rivals(field, {nowMs = null, each = 2, boundaries = null} = {}) {
    return rivalsOf(rows(field, {nowMs, boundaries}), {each});
}

const MIN_PACE_S_PER_MIN = 0.3;   // a slower change is holding, not a gain or a loss

/**
 * How the trend reads for display: the sustained pace (the last four minutes) once there is
 * enough of it, the last minute's trend until then. Returns {sPerMin (+ you gain), word:
 * 'gaining' | 'losing' | 'holding', sustained} or null.
 */
export function drift(r) {
    const pace = r?.paceSPerMin;
    if (Number.isFinite(pace)) {
        return {sPerMin: pace, word: Math.abs(pace) < MIN_PACE_S_PER_MIN ? 'holding' : pace > 0 ? 'gaining' : 'losing', sustained: true};
    }
    return r?.trend ? {sPerMin: r.gainSPerMin, word: r.trend, sustained: false} : null;
}

// ---- the rivals track's range and the field's gap mode (settings) ----

export const TRACK_RANGES = ['30', '60', '120', '300', 'field'];
export const DEFAULT_TRACK_RANGE = '60';
export const GAP_MODES = ['clock', 'finish'];
const FIELD_STEPS_S = [15, 30, 60, 120, 300, 600];

/** A saved track range the strip knows (any other value, the retired 'play' included, reads as the default). */
export function trackRangeOf(v) {
    const s = String(v);
    return TRACK_RANGES.includes(s) ? s : DEFAULT_TRACK_RANGE;
}

/** The field's gap: now (on the clock at your distance) or at the finish. The retired 'road' reads as now. */
export function gapModeOf(v) {
    return GAP_MODES.includes(v) ? v : 'clock';
}

/**
 * The saved values a window's settings must change to (retired options moved on): a road gap
 * becomes now, the 'play' track range becomes one minute. Returns {key: value} for the changes.
 */
export function migrateFieldPrefs(p = {}) {
    const changes = {};
    if (p.gapMode === 'road') {
        changes.gapMode = 'clock';
    }
    if (p.rivalsRange != null && !TRACK_RANGES.includes(String(p.rivalsRange))) {
        changes.rivalsRange = DEFAULT_TRACK_RANGE;
    }
    return changes;
}

/**
 * The rivals track's range each way and which riders it shows, on the clock. mode: '30' | '60'
 * | '120' | '300' seconds each way, or 'field' (wide enough for everyone). Riders outside the
 * range are left off the track and counted per side.
 * Returns {rangeS, shown, hiddenAhead, hiddenBehind}.
 */
export function trackScale(all, {mode = DEFAULT_TRACK_RANGE} = {}) {
    const m = trackRangeOf(mode);
    let rangeS;
    if (m === 'field') {
        const far = all.reduce((x, r) => Math.max(x, Math.abs(r.gapS)), 0);
        rangeS = FIELD_STEPS_S.find(x => x >= far) ?? Math.ceil(far / 60) * 60;
    } else {
        rangeS = Number(m);
    }
    return {
        rangeS,
        shown: all.filter(r => Math.abs(r.gapS) <= rangeS),
        hiddenAhead: all.filter(r => r.gapS > rangeS).length,
        hiddenBehind: all.filter(r => r.gapS < -rangeS).length,
    };
}
