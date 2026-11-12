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

export function fmtDelta(seconds) {
    if (!Number.isFinite(seconds)) {
        return '';
    }
    const sign = seconds >= 0 ? '+' : '-';
    return `${sign}${fmtTime(Math.abs(seconds))}`;
}

/** Words, not signs, for the finish delta (docs/REVAMP_PLAN.md §2). */
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
