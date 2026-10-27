// The interval list window (docs/REVAMP_PLAN.md 4.5, Phase 4.1): every interval of the plan
// with where it ends, its target, time, gradient and W′, and once ridden how it went. Rows are
// built once per plan and their cells rewritten only when their text changes; the current row
// sits a third of the way down so more of what is coming is in view.
import {startWindow, statusWords} from './views/runtime.mjs';
import {clipboardCode} from './views/plan-loader.mjs';
import {setText, setHidden, setClass, fmtTime, deltaWords} from './views/dom.mjs';
import {planTimeAtMetre} from './engine/tracking.mjs';

const MANUAL_SCROLL_HOLD_MS = 5000;

const els = {};
let win = null;
let rowsFor = null;            // plan signature the rows were built for
let rowEls = [];
let activeIndex = null;
let holdScrollUntil = 0;

export function main() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
    const hold = () => { holdScrollUntil = Date.now() + MANUAL_SCROLL_HOLD_MS; };
    els.rows.addEventListener('wheel', hold, {passive: true});
    els.rows.addEventListener('touchstart', hold, {passive: true});
    els.rows.addEventListener('pointerdown', hold);
    els.loadPlan.addEventListener('click', loadFromInput);
    els.planCode.addEventListener('keydown', ev => ev.key === 'Enter' && loadFromInput());
    startWindow({render, onReady: api => { win = api; }});
    // No plan yet: a share code on the clipboard is put in the box when the window gains focus.
    window.addEventListener('focus', offerClipboard);
    offerClipboard();
}

async function offerClipboard() {
    if (!win || win.view().plan || els.planCode.value) {
        return;
    }
    const code = await clipboardCode();
    if (code && !els.planCode.value) {
        els.planCode.value = code;
        setText(els.message, `${code} is on your clipboard: press Load.`);
        els.message.classList.add('ok');
    }
}

async function loadFromInput() {
    els.loadPlan.disabled = true;
    setText(els.message, 'Loading…');
    els.message.classList.remove('ok');
    try {
        const code = await win.loadCode(els.planCode.value);
        setText(els.message, `Plan ${code} loaded.`);
        els.message.classList.add('ok');
        els.planCode.value = '';
    } catch (err) {
        setText(els.message, err.message);
    } finally {
        els.loadPlan.disabled = false;
    }
}

function render(v) {
    const plan = v.plan;
    const race = v.race;
    setClass(els.list, 'choosing', !plan);
    setHidden(els.empty, Boolean(plan));
    setHidden(els.spectating, !v.spectating);
    if (v.spectating) {
        setText(els.spectating, `spectating ${v.spectating.name ?? 'another rider'}: your statistics are paused`);
    }
    if (!plan) {
        setText(els.route, 'TT interval list');
        for (const id of ['finish', 'facts', 'delta', 'power', 'controls']) {
            setText(els[id], '');
        }
        if (rowsFor) {
            els.rows.replaceChildren();
            rowsFor = null;
            rowEls = [];
        }
        return;
    }

    // Header.
    setText(els.route, plan.routeName ?? 'Custom route');
    const planTime = fmtTime(race.planTimeFromStartS ?? plan.timeS);
    if (v.status === 'finished') {
        setText(els.finish, fmtTime(race.elapsedS));
    } else if (race.running && race.totalS != null) {
        setText(els.finish, fmtTime(race.totalS));
    } else {
        setText(els.finish, planTime);
    }
    // The strategy ridden, when the plan has the optimiser's cards: "balanced plan 14:23 ...".
    const strategy = plan.strategyLabel ? `${plan.strategyLabel.toLowerCase()} ` : '';
    const facts = v.status === 'racing' || v.status === 'finished'
        ? `${strategy}plan ${planTime}, ${race.completed} of ${plan.intervals} intervals ridden`
        : `${strategy}plan ${planTime} over ${(plan.lengthM / 1000).toFixed(2)} km, ${statusWords(v)}`;
    setText(els.facts, facts);
    const words = (race.running && race.pacingSampleS > 0) || v.status === 'finished' ? deltaWords(race.deltaS) : '';
    setText(els.delta, words);
    setClass(els.delta, 'ahead', words.startsWith('ahead'));
    setClass(els.delta, 'behind', words.startsWith('behind'));
    const actual = rideAverage(v.stats);
    setText(els.power, actual != null
        ? `avg ${Math.round(plan.avgPowerW)} W planned, ${Math.round(actual)} W so far`
        : `avg ${Math.round(plan.avgPowerW)} W planned, W′ ${(plan.wPrimeJ / 1000).toFixed(1)} kJ`);
    const c = v.controls;
    const ctl = [c.offsetM ? `offset ${c.offsetM > 0 ? '+' : ''}${Math.round(c.offsetM)} m` : '', c.bias !== 1 ? `bias ${Math.round(c.bias * 100)}%` : ''].filter(Boolean).join(', ');
    setText(els.controls, ctl);

    // Rows.
    const intervals = win.engine.state.plan.intervals;
    const signature = win.engine.state.plan.signature;
    if (rowsFor !== signature) {
        buildRows(intervals);
        rowsFor = signature;
        activeIndex = null;
    }
    const bandW = win.engine.state.prefs.bandWidthW;
    const nowIdx = v.target?.index ?? null;
    for (const iv of intervals) {
        updateRow(rowEls[iv.index], iv, v.stats[iv.index], v, bandW, iv.index === nowIdx);
    }
    if (nowIdx !== activeIndex) {
        activeIndex = nowIdx;
        scrollToActive();
    }
}

function buildRows(intervals) {
    rowEls = intervals.map(iv => {
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.index = String(iv.index);
        row.innerHTML = '<span class="c n"></span><span class="c to"></span><span class="c w"><b></b><small></small></span>'
            + '<span class="c t"><b></b><small class="d-time"></small></span><span class="c g"></span><span class="c wb"><b></b><small></small></span>';
        const [n, to, w, t, g, wb] = row.children;
        row.cells = {n, to, w: w.firstChild, wd: w.lastChild, t: t.firstChild, td: t.lastChild, g, wb: wb.firstChild, wbd: wb.lastChild};
        row.cache = {};
        setText(n, String(iv.number));
        return row;
    });
    els.rows.replaceChildren(...rowEls);
}

function put(row, key, el, text, cls = null) {
    if (row.cache[key] !== text) {
        row.cache[key] = text;
        el.textContent = text;
    }
    if (cls !== null && row.cache[`${key}.cls`] !== cls) {
        row.cache[`${key}.cls`] = cls;
        el.className = cls;
    }
}

function updateRow(row, iv, s, v, bandW, isNow) {
    const done = Boolean(s?.finished);
    const bias = v.controls.bias;
    const offset = v.controls.offsetM;
    put(row, 'to', row.cells.to, ((iv.endM - offset) / 1000).toFixed(2));
    // Target: the biased figure ahead of the rider, the plan's once ridden, with the average against it.
    const targetW = done ? iv.powerW : iv.powerW * bias;
    put(row, 'w', row.cells.w, String(Math.round(targetW)));
    if (done && !s.partial && s.avgPowerW != null) {
        const d = s.avgPowerW - iv.powerW;
        const band = d < -bandW ? 'd-under' : d > bandW ? 'd-over' : 'd-on';
        put(row, 'wd', row.cells.wd, `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d))}`, band);
    } else {
        put(row, 'wd', row.cells.wd, '');
    }
    put(row, 't', row.cells.t, iv.durationText ?? fmtTime(iv.durationS));
    if (done && !s.partial) {
        // The interval the clock started in is timed from the line, so is its plan time.
        const intervals = win.engine.state.plan.intervals;
        const planS = Number.isFinite(s.startPlanM) && s.startPlanM > iv.startM
            ? iv.endTimeS - planTimeAtMetre(intervals, s.startPlanM)
            : iv.durationS;
        const d = Math.round(s.elapsedS - planS);
        put(row, 'td', row.cells.td, Math.abs(d) < 1 ? '' : `${d > 0 ? '+' : '−'}${Math.abs(d)} s`);
    } else {
        put(row, 'td', row.cells.td, '');
    }
    const g = iv.grade;
    put(row, 'g', row.cells.g, Number.isFinite(g) ? `${g > 0.5 ? '▲' : g < -0.5 ? '▼' : '▬'} ${g.toFixed(1)}%` : '',
        `c g${g > 0.5 ? ' grade-up' : g < -0.5 ? ' grade-down' : ''}`);
    put(row, 'wb', row.cells.wb, Number.isFinite(iv.wbalKj) ? iv.wbalKj.toFixed(1) : '');
    if (done && Number.isFinite(s.wbalEndJ) && Number.isFinite(iv.wbalKj)) {
        const d = s.wbalEndJ / 1000 - iv.wbalKj;
        // Less W′ left than planned means harder than planned.
        const band = d < -0.3 ? 'd-over' : d > 0.3 ? 'd-under' : 'd-on';
        put(row, 'wbd', row.cells.wbd, Math.abs(d) < 0.05 ? '' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}`, band);
    } else {
        put(row, 'wbd', row.cells.wbd, '');
    }
    const state = `row${done ? ' done' : ''}${isNow ? ' now' : ''}${isNow && isSoon(v) ? ' soon' : ''}`;
    if (row.cache.cls !== state) {
        row.cache.cls = state;
        row.className = state;
    }
    const p = isNow && v.target && !v.target.beforePlan ? `${(v.target.progress * 100).toFixed(1)}%` : '0%';
    if (row.cache.p !== p) {
        row.cache.p = p;
        row.style.setProperty('--p', p);
    }
}

function isSoon(v) {
    const soonS = Number(win.prefs().soonSec) || 10;
    return v.status === 'racing' && v.next != null && ((v.next.inS != null && v.next.inS <= soonS) || (v.next.inM != null && v.next.inM <= 100));
}

function scrollToActive() {
    if (Date.now() < holdScrollUntil || activeIndex == null) {
        return;
    }
    requestAnimationFrame(() => {
        const row = rowEls[activeIndex];
        const c = els.rows;
        if (!row) {
            return;
        }
        const target = row.offsetTop - c.offsetTop - c.clientHeight / 3;
        const next = Math.max(0, Math.min(target, c.scrollHeight - c.clientHeight));
        if (Math.abs(c.scrollTop - next) > 1) {
            c.scrollTop = next;
        }
    });
}

function rideAverage(stats) {
    let work = 0;
    let time = 0;
    for (const s of stats ?? []) {
        if (s && s.elapsedS > 0 && Number.isFinite(s.workJ)) {
            work += s.workJ;
            time += s.elapsedS;
        }
    }
    return time >= 10 ? work / time : null;
}
