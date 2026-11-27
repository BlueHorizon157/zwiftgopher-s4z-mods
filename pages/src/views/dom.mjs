// Small DOM helpers for the views: write only when the value changed.
export function setText(el, text) {
    if (el && el.textContent !== text) {
        el.textContent = text;
    }
}

export function setHtml(el, html) {
    if (el && el.__html !== html) {
        el.__html = html;
        el.innerHTML = html;
    }
}

export function setHidden(el, hidden) {
    if (el && el.hidden !== Boolean(hidden)) {
        el.hidden = Boolean(hidden);
    }
}

export function setClass(el, name, on) {
    if (el) {
        el.classList.toggle(name, Boolean(on));
    }
}

export function setAttr(el, name, value) {
    if (el && el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
    }
}

export function fmtTime(seconds, {dash = '—:—'} = {}) {
    if (!Number.isFinite(seconds)) {
        return dash;
    }
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * A plan's time, to the nearest second as the planner rounds its own ("14:55" for 894.7 s), so the
 * HUD, the list and the strategy buttons show one figure. A clock (fmtTime) shows the whole
 * second it has reached, as the game's does.
 */
export function fmtPlanTime(seconds, opts) {
    return fmtTime(Number.isFinite(seconds) ? Math.round(seconds) : seconds, opts);
}

/** Seconds to a change: "37 s" up to 99, then a clock ("1:40"), so a long interval does not read "1680 s". */
export function fmtCountdown(seconds) {
    if (!Number.isFinite(seconds)) {
        return '';
    }
    const s = Math.max(0, Math.round(seconds));
    return s <= 99 ? `${s} s` : fmtTime(s);
}

/** "+3" or "−3" for a difference in whole watts; nothing when it rounds to 0 (never "−0"). */
export function fmtWattDelta(watts) {
    const r = Math.round(watts);
    return Number.isFinite(watts) && r !== 0 ? `${r > 0 ? '+' : '−'}${Math.abs(r)}` : '';
}

/**
 * A distance: to the nearest 10 m under a kilometre, else kilometres (two decimals, one from 10 km);
 * km: always kilometres. Never negative, and 996 m is "1.00 km", not "1000 m".
 */
export function fmtDistance(m, km = false) {
    if (!Number.isFinite(m)) {
        return '';
    }
    const d = Math.max(0, m);
    const tens = Math.round(d / 10) * 10;
    if (km || tens >= 1000) {
        return `${(d / 1000).toFixed(d >= 10000 ? 1 : 2)} km`;
    }
    return `${tens} m`;
}

export function fmtDelta(seconds) {
    if (!Number.isFinite(seconds)) {
        return '';
    }
    const sign = seconds >= 0 ? '+' : '-';
    return `${sign}${fmtTime(Math.abs(seconds))}`;
}

/** Words, not signs, for the finish delta. */
export function deltaWords(seconds) {
    if (!Number.isFinite(seconds)) {
        return '';
    }
    if (Math.abs(seconds) < 3) {
        return 'on plan';
    }
    return seconds < 0 ? `ahead ${fmtTime(-seconds)}` : `behind ${fmtTime(seconds)}`;
}

export function fmtKm(m, digits = 2) {
    return Number.isFinite(m) ? `${(m / 1000).toFixed(digits)} km` : '— km';
}

export function fmtGrade(pct) {
    if (!Number.isFinite(pct)) {
        return '—%';
    }
    const t = pct.toFixed(1);
    return `${t === '-0.0' ? '0.0' : t}%`;
}

/**
 * The time in a finish figure ({label, seconds}, finishFigure): a plan time and a predicted
 * finish are rounded to the second as the planner rounds a plan's time, the time to go and the
 * rider's own finished time are the whole seconds the clock has reached.
 */
export function figureTime(fig) {
    return fig.label === 'plan' || fig.label === 'finish' ? fmtPlanTime(fig.seconds) : fmtTime(fig.seconds);
}

/** The finish figure with its label, for a header that has no label cell: "12:02 to go", "plan 14:55", "finished 14:47". */
export function figureText(fig) {
    const t = figureTime(fig);
    return fig.label === 'to go' ? `${t} to go` : `${fig.label} ${t}`;
}

/**
 * The plan's time as shown beside the finish figure, on the same clock: in a mass start, once the
 * seconds from the gun to the timing line are known, the plan's time (which runs from the line)
 * plus those seconds, so that the rider's time less the plan's is the delta shown.
 */
export function planTimeS(v) {
    const race = v?.race ?? {};
    const s = race.planTimeFromStartS ?? v?.plan?.timeS ?? null;
    return s != null && race.gunToLineS != null ? s + race.gunToLineS : s;
}

/**
 * The finish cell for any window: {label, seconds}. While racing it is the predicted time to
 * go (finishShows 'remaining', the default) or the predicted finish time ('finish'); before
 * the start the plan's time, which is both; after the finish the rider's time. The delta from
 * the plan (ahead, behind, on plan) goes beside it either way. In a mass start the finish time
 * and the rider's time are the result's, from the gun (race.official*); the plan's time and
 * the delta are from the timing line, where the plan starts.
 */
export function finishFigure(v, finishShows = 'remaining') {
    const race = v.race ?? {};
    const plan = v.plan;
    if (!plan) {
        return {label: finishShows === 'finish' ? 'finish' : 'to go', seconds: null};
    }
    if (v.status === 'finished') {
        return {label: 'finished', seconds: race.officialElapsedS ?? race.elapsedS ?? null};
    }
    if (race.running && race.totalS != null) {
        return finishShows === 'finish'
            ? {label: 'finish', seconds: race.officialTotalS ?? race.totalS}
            : {label: 'to go', seconds: race.remainingS ?? Math.max(0, race.totalS - (race.elapsedS ?? 0))};
    }
    return {label: 'plan', seconds: race.planTimeFromStartS ?? plan.timeS ?? null};
}

/**
 * Average power over the tracked intervals: the work over the seconds that had a power reading
 * (the engine's workJ and powerS), so a dropout is not counted as 0 W. null before minS seconds.
 */
export function rideAverage(stats, minS = 0) {
    let work = 0;
    let seconds = 0;
    for (const s of stats ?? []) {
        if (s && s.powerS > 0 && Number.isFinite(s.workJ)) {
            work += s.workJ;
            seconds += s.powerS;
        }
    }
    return seconds > 0 && seconds >= minS ? work / seconds : null;
}

/** The lowest bias the tray's − goes to: 1 %, never 0 (the targets would be 0 W, and the store reads 0 as no bias). */
export const MIN_BIAS = 0.01;

/** Whether the tray's − may lower the bias one more step (bias is a share: 1 is 100 %). */
export function canLowerBias(bias) {
    return Number.isFinite(bias) && bias - 0.01 >= MIN_BIAS - 1e-9;
}
