// Where the rider is on the plan's own course (docs/prediction-pipeline.md, "How the plan metre
// is found"). The plan file carries the planner's course points on the plan's metre axis
// (route.course, format zg-course/1). The rider's lat/lng is matched onto those points, which
// places the rider on the road, and the Sauce odometer (eventDistance x k) carries the position
// between matches. Pure: no DOM, no storage, no timers. The tracker is state the caller steps
// once per tick; nothing here reads a clock.
//
// Why: the game's eventDistance starts at the timing line, which sits 0 to 160 m into the route
// data (no rule places it: measured per route, 2026-11-10 and before). The plan metre is the
// route data's metre, so the line must be found, and the plan's route data can be longer than
// the game's raced distance by a lead-in and a lap scale. Matching the rider's position against
// the course finds both at once, on every route measured: the residual is 2.4 to 2.9 m median.
//
// Format (zg-course/1, written by the planner into the plan file's route.course):
//   m    plan metre x 10 (decimetres): first absolute, the rest deltas (>= 0)
//   lat  latitude x 1e6: first absolute, the rest deltas
//   lng  longitude x 1e6: first absolute, the rest deltas
//   ele  route elevation (metres) x 10: first absolute, the rest deltas
//   real_from_m / real_to_m: plan metres that are real road (padding is outside them)

export const COURSE_FORMAT = 'zg-course/1';
export const EARTH_R_M = 6371000;   // the planner's radius
export const CELL_M = 50;           // the grid of segments
export const SEARCH_M = 15;         // a fix looks for road this close
export const MAX_OFFSET_M = 10;     // a fix is used only this close to the road
export const GATE_M = 40;           // once locked: the candidate must be this near the odometer's metre
export const ALPHA = 0.15;          // the blend toward an accepted fix, per fix
export const LOCK_FIXES = 4;        // consistent fixes to lock
export const LOCK_SPAN_M = 30;      // ... spread over this much of the odometer (not one spot)
export const LOCK_TOL_M = 8;        // a fix agrees with a line when its road metre is within this
export const LOCK_WINDOW_M = 300;   // the fixes kept for locking: this much odometer
export const LINE_MIN_M = -150;     // a plausible timing line: the route data starts up to this
export const LINE_MAX_M = 300;      //   before the line and no more than this after (multi-lap courses
                                    //   repeat the road a lap apart: this keeps the first lap's line)
export const UNLOCK_M = 600;        // this much odometer with no accepted fix: lost; the metre is then carried
                                    //   on the odometer from the last line (no fix needed) until a fix relocks
export const MAX_SPEED_MS = 40;     // no rider's odometer step can exceed this per second between ticks (plus slack):
export const STEP_SLACK_M = 5;      //   a bigger step is a bad reading, held back for one tick
export const SCALE_MIN = 0.9;
export const SCALE_MAX = 1.1;
const SAME_M = 0.5;                 // two candidates this close in metres are one place (a vertex)

/**
 * The course as decoded arrays in metres and degrees, or null when the block is missing or
 * does not hold up (format, count, finite and integer values, monotone metres, sane lat/lng).
 */
export function decodeCourse(raw) {
    if (!raw || typeof raw !== 'object' || raw.format !== COURSE_FORMAT) {
        return null;
    }
    const n = raw.count;
    if (!Number.isInteger(n) || n < 2) {
        return null;
    }
    const m = accumulate(raw.m, n, 10, true);
    const lat = accumulate(raw.lat, n, 1e6, false);
    const lng = accumulate(raw.lng, n, 1e6, false);
    const ele = accumulate(raw.ele, n, 10, false);
    if (!m || !lat || !lng || !ele) {
        return null;
    }
    for (let i = 0; i < n; i++) {
        if (Math.abs(lat[i]) > 90 || Math.abs(lng[i]) > 180) {
            return null;
        }
    }
    const realFromM = finiteOr(raw.real_from_m, 0);
    const realToM = finiteOr(raw.real_to_m, m[n - 1]);
    if (realToM <= realFromM || m[n - 1] < m[0]) {
        return null;
    }
    return {count: n, m, lat, lng, ele, realFromM, realToM};
}

/** The odometer scale from a plan file (planner: ROUTE_DATA_M_PER_GAME_M or the route's measured value), or null. */
export function scaleOf(v) {
    const k = Number(v);
    return v != null && Number.isFinite(k) && k >= SCALE_MIN && k <= SCALE_MAX ? k : null;
}

function accumulate(arr, n, scale, nonNegativeDeltas) {
    if (!Array.isArray(arr) || arr.length !== n) {
        return null;
    }
    const out = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (!Number.isInteger(v)) {
            return null;
        }
        if (i === 0) {
            acc = v;
        } else {
            if (nonNegativeDeltas && v < 0) {
                return null;
            }
            acc += v;
        }
        out[i] = acc / scale;
    }
    return out;
}

function finiteOr(v, fallback) {
    const n = Number(v);
    return v != null && Number.isFinite(n) ? n : fallback;
}

// The grid index of a course, built once per decoded course (a WeakMap, so a course's index
// lives as long as the course does).
const INDEX = new WeakMap();

export function courseIndex(course) {
    let idx = INDEX.get(course);
    if (!idx) {
        idx = buildIndex(course);
        INDEX.set(course, idx);
    }
    return idx;
}

function buildIndex(course) {
    const n = course.count;
    let lat0 = 0;
    let lng0 = 0;
    for (let i = 0; i < n; i++) {
        lat0 += course.lat[i];
        lng0 += course.lng[i];
    }
    lat0 /= n;
    lng0 /= n;
    const ky = EARTH_R_M * Math.PI / 180;
    const kx = ky * Math.cos(lat0 * Math.PI / 180);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        x[i] = (course.lng[i] - lng0) * kx;
        y[i] = (course.lat[i] - lat0) * ky;
    }
    const cells = new Map();
    for (let i = 0; i < n - 1; i++) {
        const minX = Math.min(x[i], x[i + 1]) - SEARCH_M;
        const maxX = Math.max(x[i], x[i + 1]) + SEARCH_M;
        const minY = Math.min(y[i], y[i + 1]) - SEARCH_M;
        const maxY = Math.max(y[i], y[i + 1]) + SEARCH_M;
        for (let cx = Math.floor(minX / CELL_M); cx <= Math.floor(maxX / CELL_M); cx++) {
            for (let cy = Math.floor(minY / CELL_M); cy <= Math.floor(maxY / CELL_M); cy++) {
                const key = `${cx},${cy}`;
                let list = cells.get(key);
                if (!list) {
                    list = [];
                    cells.set(key, list);
                }
                list.push(i);
            }
        }
    }
    return {lat0, lng0, kx, ky, x, y, cells};
}

/**
 * The course's places within SEARCH_M of a lat/lng: [{m, offset}] sorted by metre, one per place
 * (a vertex shared by two segments is one place). The course crosses itself and repeats per lap,
 * so one fix can have several. Empty for a missing or nonsense fix.
 */
export function candidatesAt(course, lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        return [];
    }
    const idx = courseIndex(course);
    const px = (lng - idx.lng0) * idx.kx;
    const py = (lat - idx.lat0) * idx.ky;
    const seen = new Set();
    const out = [];
    for (let cx = Math.floor((px - SEARCH_M) / CELL_M); cx <= Math.floor((px + SEARCH_M) / CELL_M); cx++) {
        for (let cy = Math.floor((py - SEARCH_M) / CELL_M); cy <= Math.floor((py + SEARCH_M) / CELL_M); cy++) {
            for (const i of idx.cells.get(`${cx},${cy}`) ?? []) {
                if (seen.has(i)) {
                    continue;
                }
                seen.add(i);
                const c = projectOnSegment(course, idx, i, px, py);
                if (c && c.offset <= SEARCH_M) {
                    out.push(c);
                }
            }
        }
    }
    out.sort((a, b) => a.m - b.m);
    const places = [];
    for (const c of out) {
        const last = places.at(-1);
        if (last && c.m - last.m <= SAME_M) {
            if (c.offset < last.offset) {
                places[places.length - 1] = c;
            }
        } else {
            places.push(c);
        }
    }
    return places;
}

function projectOnSegment(course, idx, i, px, py) {
    const x0 = idx.x[i];
    const y0 = idx.y[i];
    const dx = idx.x[i + 1] - x0;
    const dy = idx.y[i + 1] - y0;
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) {
        return null;
    }
    // Only the segment's own stretch counts. A fix past its end projects onto the end vertex
    // with the along-road distance as its offset, which would pass for a fix on the road for
    // the first metres past every vertex; the next segment carries that stretch.
    const t = ((px - x0) * dx + (py - y0) * dy) / len2;
    if (t < 0 || t > 1) {
        return null;
    }
    const qx = x0 + t * dx;
    const qy = y0 + t * dy;
    const m0 = course.m[i];
    return {m: m0 + t * (course.m[i + 1] - m0), offset: Math.hypot(px - qx, py - qy)};
}

/**
 * A tracker for one plan's course. k is the odometer scale (plan.routeMPerGameM, else 1).
 * Fields: locked, m (the plan metre: while locked, or carried after a loss), lineM (the implied
 * timing line, kept through a loss), carried (lost after a lock: m runs on the odometer from
 * lineM), residualM (the last accepted fix against the odometer's metre), offsetM (its distance
 * from the road), sinceFixM (odometer metres since that fix), locks (how many times it has locked).
 */
export function createCourseTracker(course, {routeMPerGameM = null} = {}) {
    return {
        course,
        k: scaleOf(routeMPerGameM) ?? 1,
        locked: false,
        carried: false,
        m: null,
        lineM: null,
        residualM: null,
        offsetM: null,
        sinceFixM: null,
        prevEd: null,
        resyncPending: false,
        obs: [],
        locks: 0,
    };
}

/**
 * One tick: the rider's lat/lng and the Sauce event distance (metres from the timing line, null
 * or non-finite when there is none). lineHintM is the line the rule or the file gives, used only
 * to choose between lines that fit equally well. dtS is the seconds since the last tick (the
 * caller's clock; 1 when not known), which bounds how far the odometer can step in one tick.
 * Mutates and returns tr with justLocked / justUnlocked for this tick. Before the first lock,
 * m is null and the caller keeps the old rule; after a loss m is carried (see unlock).
 */
export function advanceCourse(tr, {lat, lng, eventM, lineHintM = null, dtS = 1}) {
    tr.justLocked = false;
    tr.justUnlocked = false;
    let ed = Number.isFinite(eventM) ? eventM : null;
    // Zero once the race has started is a dropped reading (the odometer does not go back to the
    // line): it is missing, and the odometer carries on from the last real value.
    if (ed != null && ed <= 0 && tr.prevEd != null && tr.prevEd > 0) {
        ed = null;
    }
    let dED = 0;
    if (ed != null && tr.prevEd != null && ed > tr.prevEd) {
        const step = ed - tr.prevEd;
        // A step no rider could ride in this tick is a bad reading: held back for one tick. If the
        // next tick still shows it, it is a real jump (a gap in the feed) and it is taken.
        if (step > maxStepM(dtS) && !tr.resyncPending) {
            tr.resyncPending = true;
            ed = null;
        } else {
            dED = step;
        }
    }
    if (ed != null) {
        tr.prevEd = ed;
        tr.resyncPending = false;
    }
    const k = tr.k;
    const odo = k * dED;
    const fixes = candidatesAt(tr.course, lat, lng).filter(c => c.offset <= MAX_OFFSET_M
        && c.m >= tr.course.realFromM && c.m <= tr.course.realToM);

    if (tr.locked) {
        tr.sinceFixM += odo;
        const pred = tr.m + odo;
        let next = pred;
        let best = null;
        for (const c of fixes) {
            const d = Math.abs(c.m - pred);
            if (d <= GATE_M && (!best || d < best.d)) {
                best = {c, d};
            }
        }
        if (best) {
            next = pred + ALPHA * (best.c.m - pred);
            tr.sinceFixM = 0;
            tr.residualM = best.c.m - pred;
            tr.offsetM = best.c.offset;
        }
        // Never backwards while racing: a fix that would pull the metre back holds it.
        tr.m = Math.max(next, tr.m);
        if (ed != null) {
            tr.lineM = tr.m - k * ed;
        }
        if (tr.sinceFixM > UNLOCK_M) {
            unlock(tr);
            tr.justUnlocked = true;
        }
        return tr;
    }

    // Lost after a lock: the metre runs on the odometer from the last line, never backwards.
    if (tr.carried && ed != null) {
        tr.m = Math.max(tr.m, tr.lineM + k * ed);
    }

    // Unlocked: the fixes before the line (ed 0) say nothing about the line; locking needs the
    // odometer to have moved.
    if (ed == null || !(ed > 0) || fixes.length === 0) {
        return tr;
    }
    tr.obs.push({ed, cands: fixes});
    tr.obs = tr.obs.filter(o => o.ed >= ed - LOCK_WINDOW_M);
    const hit = lockSearch(tr, ed, lineHintM);
    if (hit) {
        // A relock never moves the metre back: a line that puts the rider behind the carried
        // metre keeps the carried metre (the odometer is the better guide over a short loss).
        let line = hit.line;
        if (tr.m != null && line + k * ed < tr.m) {
            line = tr.m - k * ed;
        }
        tr.locked = true;
        tr.carried = false;
        tr.locks += 1;
        tr.justLocked = true;
        tr.m = line + k * ed;
        tr.lineM = line;
        tr.residualM = 0;
        tr.offsetM = hit.offset;
        tr.sinceFixM = 0;
        tr.obs = [];
    }
    return tr;
}

/**
 * Lost: no accepted fix for UNLOCK_M of odometer. The line and the metre are kept, so the metre
 * runs on the odometer (carried) until a fix relocks; before any lock there is nothing to carry.
 */
function unlock(tr) {
    tr.locked = false;
    tr.carried = tr.lineM != null;
    tr.sinceFixM = null;
    tr.residualM = null;
    tr.offsetM = null;
    tr.obs = [];
}

/**
 * The largest odometer step a tick can carry: MAX_SPEED_MS over the seconds since the last tick,
 * at least two seconds (Sauce's distance comes in bursts: 27 m in 0.5 s was seen on a real ride),
 * plus slack.
 */
export function maxStepM(dtS) {
    const dt = Number.isFinite(dtS) ? Math.max(dtS, 2) : 2;
    return MAX_SPEED_MS * dt + STEP_SLACK_M;
}

// The line that the most of the recent fixes agree with: each candidate of the newest fix gives
// a line (its metre minus the odometer); a line is supported by a fix that has a candidate
// within LOCK_TOL_M of the line's metre at that fix's odometer. Needs LOCK_FIXES fixes spread
// over LOCK_SPAN_M of odometer. Ties go to the line nearest the hint.
function lockSearch(tr, ed, hint) {
    const k = tr.k;
    const newest = tr.obs.at(-1);
    let best = null;
    for (const c of newest.cands) {
        const line = c.m - k * ed;
        if (line < LINE_MIN_M || line > LINE_MAX_M) {
            continue;
        }
        let support = 0;
        let minEd = ed;
        for (const o of tr.obs) {
            const target = line + k * o.ed;
            if (o.cands.some(oc => Math.abs(oc.m - target) <= LOCK_TOL_M)) {
                support += 1;
                minEd = Math.min(minEd, o.ed);
            }
        }
        if (support < LOCK_FIXES || ed - minEd < LOCK_SPAN_M) {
            continue;
        }
        const prior = hint != null && Number.isFinite(hint) ? Math.abs(line - hint) : 0;
        if (!best || support > best.support || (support === best.support && prior < best.prior)) {
            best = {line, support, prior, offset: c.offset};
        }
    }
    return best;
}

/**
 * The plan metre of the rider from a tracker: while locked, the road's metre; after a loss, the
 * metre carried on the odometer (carried); null before any lock.
 */
export function courseMetre(tr) {
    return tr && Number.isFinite(tr.m) ? tr.m : null;
}
