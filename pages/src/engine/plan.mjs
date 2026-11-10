// The plan as the engine reads it (docs/REVAMP_PLAN.md 1.1): one shape in metres and
// seconds from either a plan file (zg-tt-plan/1, TT/docs/plan-file-v1.md) or a share
// payload saved before the file (the whole planner plan, km fields). Plan metre 0 is the
// pen (the planner's start_offset_m padding is inside the plan).

import {decodeCourse, scaleOf} from './course.mjs';

export const SCHEMA_V1 = 'zg-tt-plan/1';

export function isPlanFile(raw) {
    return raw?.schema === SCHEMA_V1;
}

/**
 * options.card picks a strategy card to ride instead of the plan's own intervals (5.2): its
 * key, when the file carries that card's plan_intervals; otherwise the plan as shared.
 */
export function normalisePlan(raw, {code = null, card = null} = {}) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.intervals) || raw.intervals.length === 0) {
        return null;
    }
    const file = isPlanFile(raw);
    const rider = raw.rider ?? {};
    const route = raw.route ?? {};
    const summary = raw.summary ?? {};
    const inputs = raw.inputs ?? raw.settings ?? {};
    const meta = raw.meta ?? {};

    const wPrimeJ = num(rider.wprime_used_j) ?? num(raw.settings?.wPrime) ?? null;
    const cpUsed = num(rider.cp_used) ?? num(rider.ftp) ?? null;
    const cp = num(rider.cp_wbal) ?? cpUsed;

    const here = fromHereOf(meta.from_here, wPrimeJ);
    const shared = normaliseIntervals(raw.intervals);
    const cards = Array.isArray(raw.cards) ? raw.cards.map(c => normaliseCard(c, raw.intervals)).filter(Boolean) : [];
    const chosen = card ? cards.find(c => c.key === card && c.intervals) ?? null : null;
    const intervals = chosen ? chosen.intervals : shared;
    const last = intervals[intervals.length - 1];
    const timeS = last.endTimeS;
    // The strategy being ridden: the chosen card, else the card the shared plan is.
    const ridden = chosen ?? cards.find(c => c.isShared) ?? null;
    for (const c of cards) {
        c.selected = c === ridden;
    }

    return {
        source: file ? 'file' : 'legacy',
        code,
        routeId: route.id != null ? String(route.id) : null,
        routeName: route.name ?? null,
        laps: num(route.laps),
        lengthM: last.endM,
        startOffsetM: num(route.start_offset_m),
        startLineM: num(route.start_line_m),
        // The planner's course on the plan's metres (course.mjs): null when absent or not sound.
        course: decodeCourse(route.course),
        routeMPerGameM: scaleOf(route.route_m_per_game_m),
        lineSource: route.line_source === 'measured' || route.line_source === 'rule' ? route.line_source : null,
        finishM: num(route.finish_m) > 0 ? num(route.finish_m) : null,
        leadInM: km(route.lead_in_km),
        cp,
        cpUsed,
        ftp: num(rider.ftp),
        wPrimeJ,
        weightKg: num(rider.weight),
        riderName: rider.name ?? null,
        fitnessLevel: typeof inputs.fitnessLevel === 'string' ? inputs.fitnessLevel : 'competitive',
        raceDayMarginPct: num(meta.race_day_margin_pct) ?? 0,
        wbalFloorKj: (chosen ? chosen.floorKj : null) ?? num(meta.wbal_floor_kj) ?? num(inputs.wbalFloorKj) ?? 0,
        strategy: ridden?.key ?? meta.strategy ?? inputs.strategyPreset ?? null,
        strategyLabel: ridden?.label ?? null,
        card: chosen?.key ?? null,
        sharedTimeText: summary.time_text ?? formatDuration(shared[shared.length - 1].endTimeS),
        timeS,
        timeText: chosen ? (chosen.timeText ?? formatDuration(timeS)) : (summary.time_text ?? formatDuration(timeS)),
        avgPowerW: (chosen ? chosen.avgPowerW : num(summary.avg_power_w)) ?? (timeS > 0 ? intervals.reduce((s, iv) => s + iv.powerW * iv.durationS, 0) / timeS : null),
        minWbalKj: (chosen ? chosen.minWbalKj : num(summary.min_wbal_kj)) ?? null,
        peakPowerW: intervals.reduce((m, iv) => Math.max(m, iv.powerW), 0),
        intervals,
        cards: cards.map(({intervals: rows, ...c}) => ({...c, switchable: Boolean(rows)})),
        // A plan from here is also its moment: two made on the same stretch are two plans.
        signature: signatureOf(intervals, route) + (here ? `|here:${here.rideM}@${here.worldMs}` : ''),
        fromHere: here,
    };
}

/**
 * A plan from here (views/from-here.mjs): the rest of a race or route lap, planned where the
 * rider was. The planner's meta.from_here, with the anchor the mod adds when it saves the plan
 * ({ride_m, world_ms, subgroup_id, route_id}: the ride metre and world time of plan metre 0).
 * Null on a plan from the start, or on one whose anchor is missing (it cannot be placed).
 */
function fromHereOf(fh, wPrimeJ) {
    const a = fh?.anchor;
    const rideM = num(a?.ride_m);
    const worldMs = num(a?.world_ms);
    if (!fh || typeof fh !== 'object' || rideM == null || worldMs == null) {
        return null;
    }
    const fraction = num(fh.start_wbal_fraction);
    return {
        kind: fh.kind === 'event' ? 'event' : 'route',
        rideM,
        worldMs,
        subgroupId: a.subgroup_id != null ? String(a.subgroup_id) : null,
        routeId: a.route_id != null ? String(a.route_id) : null,
        // On the plan's own W' (the one the engine tracks), as a share: the file's W' and the
        // planner's agree, and a share cannot disagree with either.
        startWbalJ: fraction != null && wPrimeJ ? Math.max(0, Math.min(1, fraction)) * wPrimeJ : null,
        cpFactor: num(fh.cp_factor) ?? 1,
        overBudget: Boolean(fh.over_budget),
        bike: fh.bike === 'tt' || fh.bike === 'road' ? fh.bike : null,
        bikeReason: typeof fh.bike_reason === 'string' ? fh.bike_reason : null,
        remainingM: num(fh.remaining_m),
    };
}

/** File (or legacy) interval rows → the engine's intervals in metres and seconds. */
export function normaliseIntervals(rows) {
    let elapsed = 0;
    return rows.map((iv, i) => {
        const startM = num(iv.start_m) ?? km(iv.start_km) ?? 0;
        const endM = num(iv.end_m) ?? km(iv.end_km) ?? startM;
        const durationS = num(iv.duration_s) ?? parseDurationText(iv.duration_text) ?? 0;
        const startTimeS = num(iv.start_time_s) ?? elapsed;
        elapsed = startTimeS + durationS;
        const lengthM = Math.max(0, endM - startM);
        return {
            index: i,
            number: i + 1,
            startM,
            endM,
            lengthM,
            powerW: num(iv.power_w) ?? 0,
            grade: num(iv.avg_gradient) ?? 0,
            durationS,
            startTimeS,
            endTimeS: startTimeS + durationS,
            speedMs: num(iv.speed_kmh) > 0 ? iv.speed_kmh / 3.6 : (durationS > 0 ? lengthM / durationS : null),
            durationText: typeof iv.duration_text === 'string' && iv.duration_text ? iv.duration_text : formatDuration(durationS),
            wbalKj: num(iv.wbal_kj),
            wbalMarginKj: num(iv.wbal_margin_kj),
            surface: iv.surface ?? null,
            marks: marksOf(iv.time_marks, lengthM, durationS),
        };
    });
}

/**
 * The plan's seconds from an interval's start to metre m (plan metres) inside it: by the
 * file's time marks when it has them (planner 2026-11-10: where in the interval the time
 * goes, a climb at the end of a flat interval), otherwise spread evenly over its metres.
 */
export function timeInto(iv, m) {
    const x = m - iv.startM;
    if (!(iv.lengthM > 0) || !(x > 0)) {
        return 0;
    }
    if (x >= iv.lengthM) {
        return iv.durationS;
    }
    const marks = iv.marks;
    if (!marks) {
        return iv.durationS * x / iv.lengthM;
    }
    // The last mark at or before x (marks are in order).
    let lo = -1;
    let hi = marks.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (marks[mid][0] <= x) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const [m0, s0] = lo >= 0 ? marks[lo] : [0, 0];
    const [m1, s1] = lo + 1 < marks.length ? marks[lo + 1] : [iv.lengthM, iv.durationS];
    return m1 > m0 ? s0 + (x - m0) / (m1 - m0) * (s1 - s0) : s1;
}

// [metres from the interval's start, seconds from its start], kept only when every mark is
// inside the interval and both columns rise; anything else reads as no marks.
function marksOf(raw, lengthM, durationS) {
    if (!Array.isArray(raw) || !raw.length || !(lengthM > 0) || !(durationS > 0)) {
        return null;
    }
    const out = [];
    let pm = 0;
    let ps = 0;
    for (const pair of raw) {
        const m = Array.isArray(pair) ? num(pair[0]) : null;
        const s = Array.isArray(pair) ? num(pair[1]) : null;
        if (m == null || s == null || m <= pm || s <= ps || m >= lengthM || s >= durationS) {
            return null;
        }
        out.push([m, s]);
        pm = m;
        ps = s;
    }
    return out;
}

// A strategy card: its figures, its own plan when the file carries plan_intervals (planner
// 2026-10-27 on), and whether it is the plan as shared (same point spans and watts).
function normaliseCard(card, sharedRows) {
    if (!card || typeof card !== 'object' || !card.key) {
        return null;
    }
    const rows = Array.isArray(card.plan_intervals) && card.plan_intervals.length ? card.plan_intervals : null;
    const spans = Array.isArray(card.intervals) ? card.intervals : null;
    const isShared = Boolean(spans) && spans.length === sharedRows.length && spans.every((t, i) => Array.isArray(t)
        && t[0] === sharedRows[i].point_start && t[1] === sharedRows[i].point_end && Math.abs(Number(t[2]) - Number(sharedRows[i].power_w)) < 0.05);
    return {
        key: String(card.key),
        label: card.label ?? card.key,
        timeS: num(card.time_seconds),
        timeText: card.time_text ?? null,
        avgPowerW: num(card.avg_power_w),
        // W' on the rider's own numbers (with a race-day margin min_wbal_kj is the reduced one).
        minWbalKj: num(card.min_wbal_rider_kj) ?? num(card.min_wbal_kj),
        floorKj: num(card.target_wbal_floor_kj),
        active: Boolean(card.is_active),
        isShared,
        intervals: rows ? normaliseIntervals(rows) : null,
    };
}

// Tells two plans apart without serialising the whole plan: route, length, the intervals'
// metres and watts to a tenth, and their times to the second (a plan edited in the planner
// can keep its watts and change its times: weight, CdA, the bike).
export function signatureOf(intervals, route = {}) {
    const parts = intervals.map(iv => `${Math.round(iv.startM * 10)}:${Math.round(iv.endM * 10)}:${Math.round(iv.powerW * 10)}:${Math.round(iv.durationS ?? 0)}`);
    return `${route.id ?? ''}|${intervals.length}|${hash(parts.join(','))}`;
}

function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

export function parseDurationText(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const parts = text.trim().split(':');
    if (parts.length >= 2 && parts.every(p => /^\d+$/.test(p))) {
        return parts.reduce((total, p) => total * 60 + Number(p), 0);
    }
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) {
        return '—';
    }
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

function num(v) {
    const n = Number(v);
    return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

function km(v) {
    const n = num(v);
    return n == null ? null : n * 1000;
}
