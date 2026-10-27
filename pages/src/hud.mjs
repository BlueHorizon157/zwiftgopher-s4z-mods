// The TT HUD window (docs/REVAMP_PLAN.md 4.4): one page, three layouts, every number from
// engine.view(). The layout comes from the manifest window's ?layout, or the settings
// page's override; look settings are data attributes on <html> so the CSS does the rest.
import {startWindow, statusWords} from './views/runtime.mjs';
import {clipboardCode} from './views/plan-loader.mjs';
import {setText, setHidden, setClass, setAttr, fmtTime, deltaWords, fmtGrade} from './views/dom.mjs';

const LAYOUTS = ['strip', 'dial', 'stack'];
const GLYPH = {under: '▼', on: '●', over: '▲'};
const DIAL = {centre: 130, startDeg: 210, totalDeg: 300, power: 118, wbal: 104, progress: 94};

const els = {};
let win = null;
let layout = 'strip';
let soonSec = 10;
let changingPlan = false;
let clipCode = null;        // a share code on the clipboard that is not the active plan (5.3)
let lastTargetIndex = null;
let swapTimer = null;

export function main() {
    const q = new URLSearchParams(window.location.search);
    // The page's own layout (hud.html, hud-dial.html, hud-stack.html differ only in it); ?layout= overrides for tests.
    const own = document.documentElement.dataset.layout;
    layout = LAYOUTS.includes(q.get('layout')) ? q.get('layout') : (LAYOUTS.includes(own) ? own : 'strip');
    document.documentElement.dataset.layout = layout;
    queryEls();
    initDial();
    startWindow({render, onSettings: applyLook, onReady: api => { win = api; }});
    initControls();
    // The clipboard is read when the HUD gains focus (a click on it), never while racing.
    window.addEventListener('focus', checkClipboard);
    checkClipboard();
}

async function checkClipboard() {
    const v = win?.view();
    if (!win || (v.plan && !win.beforeStart())) {
        return;
    }
    const code = await clipboardCode();
    const offer = code && code !== v.plan?.code ? code : null;
    if (offer !== clipCode) {
        clipCode = offer;
        win.draw();
    }
}

function queryEls() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
}

function applyLook(s) {
    const html = document.documentElement;
    const chosen = LAYOUTS.includes(s.layout) ? s.layout : layout;
    if (html.dataset.layout !== chosen) {
        html.dataset.layout = chosen;
    }
    html.dataset.bandWords = String(s.bandWords !== false);
    html.dataset.showLive = String(Boolean(s.showLive));
    soonSec = Number.isFinite(Number(s.soonSec)) ? Number(s.soonSec) : 10;
}

function initControls() {
    els.tray.addEventListener('click', ev => {
        const action = ev.target.closest('[data-action]')?.dataset.action;
        switch (action) {
            case 'offset-up': return win.nudgeOffset(1);
            case 'offset-down': return win.nudgeOffset(-1);
            case 'bias-up': return win.nudgeBias(1);
            case 'bias-down': return win.nudgeBias(-1);
            case 'reset': return win.reset();
            case 'clip-load': return loadCode(clipCode);
            case 'change-plan':
                changingPlan = !changingPlan;
                win.draw();
                if (changingPlan) {
                    els.planCode.focus();
                }
                return;
            default:
        }
    });
    els.loadPlan.addEventListener('click', loadFromInput);
    els.clipLoad.addEventListener('click', () => loadCode(clipCode));
    els.closePanel.addEventListener('click', () => {
        changingPlan = false;
        win.draw();
    });
    els.strategyChoices.addEventListener('click', ev => {
        const btn = ev.target.closest('button[data-card]');
        if (btn && !btn.disabled && win.setStrategy(btn.dataset.card || null)) {
            changingPlan = false;
            win.draw();
        }
    });
    // Before the start the banner's strategy chip opens the plan panel.
    els.banner.addEventListener('click', ev => {
        if (ev.target.closest('[data-action="strategy"]')) {
            changingPlan = true;
            win.draw();
        }
    });
    els.planCode.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
            loadFromInput();
        } else if (ev.key === 'Escape' && changingPlan) {
            changingPlan = false;
            win.draw();
        }
    });
    els.planCode.addEventListener('input', () => message(''));
}

function loadFromInput() {
    return loadCode(els.planCode.value);
}

async function loadCode(text) {
    if (!text) {
        return;
    }
    setText(els.loadPlan, '…');
    els.loadPlan.disabled = true;
    try {
        const code = await win.loadCode(text);
        message(`Plan ${code} loaded.`, true);
        els.planCode.value = '';
        changingPlan = false;
        if (code === clipCode) {
            clipCode = null;
        }
    } catch (err) {
        message(err.message);
    } finally {
        setText(els.loadPlan, 'Load');
        els.loadPlan.disabled = false;
        win.draw();
    }
}

function message(text, ok = false) {
    setText(els.idleMessage, text);
    setClass(els.idleMessage, 'ok', ok);
}

// ---- render ----

function render(v) {
    const hud = els.hud;
    const plan = v.plan;
    const target = v.target;
    const next = v.next;
    const race = v.race;
    const live = v.live;
    const now = Date.now();

    setAttr(hud, 'data-state', v.status);
    setClass(hud, 'spectating', Boolean(v.spectating));

    // Idle overlay: no plan, or the rider asked for another one.
    const showIdle = !plan || changingPlan;
    setHidden(els.idle, !showIdle);
    setClass(hud, 'choosing', showIdle);
    const beforeStart = win.beforeStart();
    if (showIdle) {
        setText(els.idleTitle, plan ? `Plan ${plan.code ?? ''}: ${plan.routeName ?? 'custom route'}` : 'Enter your plan code');
        setText(els.idleHint, !plan ? "The six-letter code from the planner's Share page, or paste its link."
            : beforeStart ? 'Pick a strategy, or enter another code. Esc keeps this plan.'
                : 'The strategy can be changed before the start. Esc keeps this plan.');
        renderStrategy(plan, beforeStart);
    }
    setHidden(els.closePanel, !(showIdle && plan));
    // A code on the clipboard: in the panel, and in the tray before the start.
    const offer = clipCode && clipCode !== plan?.code ? clipCode : null;
    setHidden(els.clip, !(showIdle && offer));
    setText(els.clipLoad, offer ? `Load ${offer}` : 'Load');
    setHidden(els.trayClip, !(offer && plan && !showIdle && beforeStart));
    setText(els.trayClip, offer ? `Load ${offer}` : 'Load');

    // Now. The band (colour, glyph, word) only means something once the clock runs; after
    // the finish the cell shows the ride's average power against the plan's.
    const intervalNo = target?.number != null && plan ? `${target.number}/${plan.intervals}` : '';
    let band = null;
    if (v.status === 'finished' && plan) {
        const avg = rideAverage(v.stats);
        setText(els.nowLabel, 'average');
        setText(els.nowW, avg != null ? String(Math.round(avg)) : '—');
        setText(els.liveW, plan.avgPowerW != null ? String(Math.round(plan.avgPowerW)) : '—');
        setText(els.bandGlyph, '');
        setText(els.bandWord, 'plan');
    } else {
        setText(els.nowLabel, target?.beforePlan ? `start ${intervalNo}`.trim() : `now ${intervalNo}`.trim());
        setText(els.nowW, target ? String(Math.round(target.powerW)) : '—');
        setText(els.liveW, live.powerW != null ? String(Math.round(live.powerW)) : '—');
        band = v.status === 'racing' ? target?.band ?? null : null;
        setText(els.bandGlyph, band ? GLYPH[band] : '●');
        setText(els.bandWord, band ?? '');
    }
    for (const b of ['under', 'on', 'over']) {
        setClass(els.live, `band-${b}`, band === b);
    }
    if (target && target.index !== lastTargetIndex) {
        if (lastTargetIndex != null && v.status === 'racing') {
            hud.classList.add('swap');
            clearTimeout(swapTimer);
            swapTimer = setTimeout(() => hud.classList.remove('swap'), 350);
        }
        lastTargetIndex = target.index;
    }

    // Next, and the boundary moment.
    let soon = false;
    if (next) {
        setText(els.nextLabel, `next ${next.number}/${plan.intervals}`);
        setText(els.nextW, String(Math.round(next.powerW)));
        setText(els.nextUnit, 'W');
        const g = next.grade;
        setText(els.nextGrade, Number.isFinite(g) ? `${g > 0.5 ? '▲' : g < -0.5 ? '▼' : '▬'} ${fmtGrade(g)}` : '');
        setClass(els.nextGrade, 'up', g > 0.5);
        setClass(els.nextGrade, 'down', g < -0.5);
        setText(els.nextInM, next.inM != null ? fmtDistance(next.inM) : '');
        setText(els.nextInS, next.inS != null ? `${Math.round(next.inS)} s` : '');
        soon = v.status === 'racing' && ((next.inS != null && next.inS <= soonSec) || (next.inM != null && next.inM <= 100));
    } else if (plan && v.status === 'finished') {
        setText(els.nextLabel, 'plan');
        setText(els.nextW, fmtTime(race.planTimeFromStartS ?? plan.timeS));
        setText(els.nextUnit, '');
        setText(els.nextGrade, `${race.completed}/${plan.intervals} intervals`);
        els.nextGrade.classList.remove('up', 'down');
        setText(els.nextInM, '');
        setText(els.nextInS, '');
    } else if (plan) {
        setText(els.nextLabel, 'to the finish');
        setText(els.nextW, race.remainingM != null ? fmtDistance(race.remainingM, true) : '—');
        setText(els.nextUnit, '');
        setText(els.nextGrade, 'finish strong');
        els.nextGrade.classList.remove('up', 'down');
        setText(els.nextInM, '');
        setText(els.nextInS, target?.toNextS != null && v.status === 'racing' ? `${Math.round(target.toNextS)} s` : '');
    } else {
        setText(els.nextLabel, 'next');
        setText(els.nextW, '—');
        setText(els.nextUnit, 'W');
        setText(els.nextGrade, '');
        setText(els.nextInM, '');
        setText(els.nextInS, '');
    }
    setClass(hud, 'soon', soon);

    // W'.
    const w = v.wbal;
    if (w) {
        setText(els.wbalKj, w.kj.toFixed(1));
        const pct = Math.max(0, Math.min(100, w.pct));
        setWidth(els.wbalFill, pct);
        const floorPct = w.floorKj > 0 && w.wPrimeJ > 0 ? (w.floorKj * 1000 / w.wPrimeJ) * 100 : null;
        setClass(els.wbalFloor, 'shown', floorPct != null);
        if (floorPct != null) {
            els.wbalFloor.style.left = `${floorPct.toFixed(1)}%`;
        }
        const racing = v.status === 'racing';
        setClass(els.wbal, 'low', racing && w.pct < 25);
        const under = racing && w.planKjAtEnd != null && w.kj < w.planKjAtEnd - 0.5;
        setText(els.wbalWord, under ? 'below plan' : (racing && w.pct < 25 ? 'running low' : ''));
        setClass(els.wbalWord, 'under', under || (racing && w.pct < 25));
    } else {
        setText(els.wbalKj, '—');
        setWidth(els.wbalFill, 0);
        setClass(els.wbalFloor, 'shown', false);
        setClass(els.wbal, 'low', false);
        setText(els.wbalWord, '');
    }

    // Finish: the predicted finish time, with the plan's as the baseline, and the delta in words.
    if (plan) {
        if (v.status === 'finished') {
            setText(els.finishLabel, 'finished');
            setText(els.finishTime, fmtTime(race.elapsedS));
        } else if (race.running && race.totalS != null) {
            setText(els.finishLabel, 'finish');
            setText(els.finishTime, fmtTime(race.totalS));
        } else {
            setText(els.finishLabel, 'plan');
            setText(els.finishTime, fmtTime(race.planTimeFromStartS ?? plan.timeS));
        }
        const words = (race.running && race.pacingSampleS > 0) || v.status === 'finished' ? deltaWords(race.deltaS) : '';
        setText(els.finishDelta, words);
        setClass(els.finishDelta, 'ahead', words.startsWith('ahead'));
        setClass(els.finishDelta, 'behind', words.startsWith('behind'));
    } else {
        setText(els.finishLabel, 'finish');
        setText(els.finishTime, '—');
        setText(els.finishDelta, '');
    }

    // Vitals and progress.
    setText(els.vCadence, live.cadence != null ? String(Math.round(live.cadence)) : '—');
    setText(els.vHr, live.heartrate != null ? String(Math.round(live.heartrate)) : '—');
    setText(els.vSpeed, live.speedKmh != null ? live.speedKmh.toFixed(1) : '—');
    const progress = target && !target.beforePlan ? target.progress * 100 : 0;
    if (document.documentElement.dataset.layout === 'stack') {
        setHeight(els.progressFill, progress);
    } else {
        setWidth(els.progressFill, progress);
    }

    // Banner.
    setBanner(v, now);

    // Tray.
    setText(els.offsetValue, `${v.controls.offsetM > 0 ? '+' : ''}${Math.round(v.controls.offsetM)} m`);
    setText(els.biasValue, `${Math.round(v.controls.bias * 100)}%`);

    if (document.documentElement.dataset.layout === 'dial') {
        renderDial(v);
    }
}

/** The strategy cards the rider can ride (with the plan as shared when it is none of them). */
function strategyChoices(plan) {
    const cards = (plan?.cards ?? []).filter(c => c.switchable);
    if (!cards.length) {
        return [];
    }
    const shared = plan.cards.find(c => c.isShared);
    const choices = cards.map(c => ({key: c.key, card: c.isShared ? '' : c.key, label: c.label, timeText: c.timeText, selected: c.selected}));
    if (!shared) {
        choices.unshift({key: 'shared', card: '', label: 'As shared', timeText: plan.sharedTimeText, selected: plan.card == null});
    }
    return choices;
}

function renderStrategy(plan, beforeStart) {
    const choices = strategyChoices(plan);
    setHidden(els.strategy, choices.length < 2);
    setText(els.strategyLabel, beforeStart ? 'strategy' : 'strategy (before the start)');
    const key = `${beforeStart}|${choices.map(c => `${c.card}:${c.selected}:${c.timeText}`).join(',')}`;
    if (els.strategyChoices.__key === key) {
        return;
    }
    els.strategyChoices.__key = key;
    els.strategyChoices.innerHTML = choices.map(c => `<button type="button" data-key="${escapeHtml(c.key)}" data-card="${escapeHtml(c.card)}" aria-pressed="${c.selected}"${beforeStart ? '' : ' disabled title="The strategy can be changed before the start"'}>`
        + `${escapeHtml(c.label)} <span class="tnum">${escapeHtml(c.timeText ?? '')}</span></button>`).join('');
}

function setBanner(v, now) {
    let text = '';
    let name = '';
    // Before the start, the strategy being ridden, as a chip that opens the plan panel.
    const chip = (v.status === 'armed' || v.status === 'idle') && !v.spectating && strategyChoices(v.plan).length > 1
        ? `<button type="button" class="chip" data-action="strategy" title="Change the strategy or the plan">${escapeHtml((v.plan.strategyLabel ?? 'as shared').toLowerCase())}</button>` : '';
    if (v.spectating) {
        text = 'spectating ';
        name = v.spectating.name ?? 'another rider';
    } else if (v.status === 'finished') {
        text = 'finished';
        name = v.plan?.routeName ? ` ${v.plan.routeName}` : '';
    } else if (v.status === 'armed') {
        const startMs = v.event?.startMs;
        if (v.event?.inEvent && startMs && startMs > now) {
            text = `starts in ${fmtTime((startMs - now) / 1000)}`;
        } else if (v.event?.inEvent && v.event.kind === 'group') {
            text = 'group event: the clock runs from the start';
        } else {
            text = v.event?.inEvent ? 'ready, waiting for the start' : 'ready';
        }
        const mm = v.event?.mismatchM;
        if (Number.isFinite(mm)) {
            text += `, plan ${mm > 0 ? 'shorter' : 'longer'} by ${Math.round(Math.abs(mm))} m`;
        }
        name = v.plan?.routeName ? ` ${v.plan.routeName}` : '';
    } else if (v.status === 'idle' && v.plan) {
        text = `${v.plan.routeName ?? 'plan'}: ${statusWords(v)}`;
    } else if (v.status === 'racing' && v.event?.inEvent && v.event.kind === 'group') {
        text = 'clock from the gun';
    }
    // The chip before the route name, so a narrow banner cuts the name, not the chip.
    const html = text ? `${escapeHtml(text)}${chip}<span class="name">${escapeHtml(name)}</span>` : '';
    if (els.banner.__html !== html) {
        els.banner.__html = html;
        els.banner.innerHTML = html;
    }
    setHidden(els.banner, !html);
}

// ---- dial ----

function initDial() {
    setArc(els.dialTrack, 0, 1, DIAL.power);
    setArc(els.dialWbalTrack, 0, 1, DIAL.wbal);
    setArc(els.dialProgressTrack, 0, 1, DIAL.progress);
}

function renderDial(v) {
    const plan = v.plan;
    const target = v.target;
    const live = v.live;
    const maxPower = plan?.peakPowerW > 0 ? Math.ceil(plan.peakPowerW * 1.25) : 600;
    const ratio = live.powerW != null ? clamp(live.powerW / maxPower, 0, 1) : 0;
    setArc(els.dialLive, 0, ratio, DIAL.power);
    setArc(els.dialLiveUnder, 0, ratio, DIAL.power);
    for (const b of ['under', 'on', 'over']) {
        setClass(els.dialLive, `band-${b}`, target?.band === b);
    }
    if (target) {
        const w = win.engine.state.prefs.bandWidthW;
        setArc(els.dialTarget, clamp((target.powerW - w) / maxPower, 0, 1), clamp((target.powerW + w) / maxPower, 0, 1), DIAL.power);
    } else {
        setArc(els.dialTarget, 0, 0, DIAL.power);
    }
    if (v.next && target && Math.abs(v.next.powerW - target.powerW) > 5) {
        setTick(els.dialNext, clamp(v.next.powerW / maxPower, 0, 1), DIAL.power, 9);
    } else {
        setAttr(els.dialNext, 'd', '');
    }
    const w = v.wbal;
    if (w) {
        setArc(els.dialWbal, 0, clamp(w.pct / 100, 0, 1), DIAL.wbal);
        setClass(els.dialWbal, 'low', w.pct < 25);
        if (w.floorKj > 0 && w.wPrimeJ > 0) {
            setTick(els.dialWbalFloor, clamp(w.floorKj * 1000 / w.wPrimeJ, 0, 1), DIAL.wbal, 5);
        } else {
            setAttr(els.dialWbalFloor, 'd', '');
        }
    } else {
        setArc(els.dialWbal, 0, 0, DIAL.wbal);
        setAttr(els.dialWbalFloor, 'd', '');
    }
    setArc(els.dialProgress, 0, target && !target.beforePlan ? clamp(target.progress, 0, 1) : 0, DIAL.progress);
}

function setArc(el, startRatio, endRatio, radius) {
    if (!el) {
        return;
    }
    if (endRatio <= startRatio) {
        setAttr(el, 'd', '');
        return;
    }
    const a0 = (DIAL.startDeg + startRatio * DIAL.totalDeg) * Math.PI / 180;
    const a1 = (DIAL.startDeg + endRatio * DIAL.totalDeg) * Math.PI / 180;
    const large = (endRatio - startRatio) * DIAL.totalDeg > 180 ? 1 : 0;
    const c = DIAL.centre;
    const x1 = c + radius * Math.cos(a0);
    const y1 = c + radius * Math.sin(a0);
    const x2 = c + radius * Math.cos(a1);
    const y2 = c + radius * Math.sin(a1);
    setAttr(el, 'd', `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`);
}

function setTick(el, ratio, radius, half) {
    const a = (DIAL.startDeg + ratio * DIAL.totalDeg) * Math.PI / 180;
    const c = DIAL.centre;
    const r0 = radius - half;
    const r1 = radius + half;
    setAttr(el, 'd', `M ${(c + r0 * Math.cos(a)).toFixed(2)} ${(c + r0 * Math.sin(a)).toFixed(2)} L ${(c + r1 * Math.cos(a)).toFixed(2)} ${(c + r1 * Math.sin(a)).toFixed(2)}`);
}

// ---- helpers ----

/** Time-weighted average power over the tracked intervals. */
function rideAverage(stats) {
    let work = 0;
    let time = 0;
    for (const s of stats ?? []) {
        if (s && Number.isFinite(s.avgPowerW) && s.elapsedS > 0) {
            work += s.avgPowerW * s.elapsedS;
            time += s.elapsedS;
        }
    }
    return time > 0 ? work / time : null;
}

function fmtDistance(m, km = false) {
    if (!Number.isFinite(m)) {
        return '';
    }
    if (km || m >= 1000) {
        return `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km`;
    }
    return `${Math.round(m / 10) * 10} m`;
}

function setWidth(el, pct) {
    const w = `${pct.toFixed(1)}%`;
    if (el && el.style.width !== w) {
        el.style.width = w;
        el.style.height = '';
    }
}

function setHeight(el, pct) {
    const h = `${pct.toFixed(1)}%`;
    if (el && el.style.height !== h) {
        el.style.height = h;
        el.style.width = '';
    }
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
