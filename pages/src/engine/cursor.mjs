// Where a plan distance falls in the plan (docs/REVAMP_PLAN.md 1.4): O(log n) from
// scratch, O(1) with the previous index as a hint, which is every tick.

export const BEFORE = -1;

/** Index of the interval containing planM, BEFORE before the plan, intervals.length past its end. */
export function locate(intervals, planM, hint = BEFORE) {
    const n = intervals.length;
    if (!Number.isFinite(planM) || n === 0) {
        return BEFORE;
    }
    if (planM < intervals[0].startM) {
        return BEFORE;
    }
    if (planM >= intervals[n - 1].endM) {
        return n;
    }
    // The hint and its neighbours cover almost every tick.
    for (const i of [hint, hint + 1, hint - 1]) {
        if (i >= 0 && i < n && intervals[i].startM <= planM && planM < intervals[i].endM) {
            return i;
        }
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (planM < intervals[mid].endM) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

/** The interval at an index, null before or after the plan. */
export function at(intervals, index) {
    return index >= 0 && index < intervals.length ? intervals[index] : null;
}

/** Metres to the next power change from planM, and progress through the current span. */
export function boundary(intervals, index, planM) {
    const n = intervals.length;
    if (index === BEFORE) {
        const first = intervals[0];
        return first ? {nextIndex: 0, toNextM: Math.max(0, first.startM - planM), progress: 0, spanM: first.startM} : null;
    }
    if (index >= n) {
        return {nextIndex: null, toNextM: 0, progress: 1, spanM: 0};
    }
    const iv = intervals[index];
    const spanM = iv.lengthM;
    return {
        nextIndex: index + 1 < n ? index + 1 : null,
        toNextM: Math.max(0, iv.endM - planM),
        progress: spanM > 0 ? Math.min(1, Math.max(0, (planM - iv.startM) / spanM)) : 1,
        spanM,
    };
}
