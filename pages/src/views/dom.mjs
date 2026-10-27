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
