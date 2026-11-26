// The TT HUD window (docs/REVAMP_PLAN.md 4.4): one page, three layouts, every number from
// engine.view(). The layout comes from the manifest window's ?layout, or the settings
// page's override; look settings are data attributes on <html> so the CSS does the rest.
import {startWindow, statusWords} from './views/runtime.mjs';
import {clipboardCode} from './views/plan-loader.mjs';
import {bannerWords, planPanelHint} from './views/banner-words.mjs';
import {setText, setHtml, setHidden, setClass, setAttr, fmtPlanTime, fmtCountdown, fmtDistance, deltaWords, fmtGrade, finishFigure, figureTime, planTimeS, canLowerBias, rideAverage} from './views/dom.mjs';

const LAYOUTS = ['strip', 'dial', 'stack'];
const GLYPH = {under: '▼', on: '●', over: '▲'};
// The dial: a 270° gauge open at the bottom (start at 135°, clockwise); rings from the outside in.
const DIAL = {centre: 130, startDeg: 135, totalDeg: 270, power: 116, time: 102, wbal: 93};

const els = {};
let win = null;
let layout = 'strip';
let soonSec = 10;
let changingPlan = false;
let clipCode = null;        // a share code on the clipboard that is not the active plan (5.3)
let lastTargetIndex = null;
let wasIdle = false;        // the plan panel was open at the last render
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
            // Never down to 0 %: the targets would be 0 W (and the store reads 0 as "no bias").
            case 'bias-down': return canLowerBias(win.view().controls.bias) ? win.nudgeBias(-1) : undefined;
            case 'reset': return win.reset();
            case 'clip-load': return loadCode(clipCode);
            case 'change-plan':
                if (changingPlan) {
                    closePlanPanel();
                } else {
                    changingPlan = true;
                    win.draw();
                    els.planCode.focus();
                }
                return;
            default:
        }
    });
    els.loadPlan.addEventListener('click', loadFromInput);
    els.clipLoad.addEventListener('click', () => loadCode(clipCode));
    els.closePanel.addEventListener('click', closePlanPanel);
    // Ride with no plan: the panel stays, offering Plan from here (or Plan it in a pen).
    els.clearPlan.addEventListener('click', () => {
        win.clearPlan();
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
    // The strategy chip (in the banner; on the dial before the start, by the plan time) opens the plan panel.
    for (const el of [els.banner, els.finishLabel]) {
        el.addEventListener('click', ev => {
            if (ev.target.closest('[data-action="strategy"]')) {
                changingPlan = true;
                win.draw();
                els.planCode.focus();      // Esc keeps the plan, as it does after the tray's Plan
            } else if (ev.target.closest('[data-action="update"]')) {
                openUpdate();
            }
        });
    }
    els.updateOpen.addEventListener('click', openUpdate);
    els.planCode.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
            loadFromInput();
        }
    });
    // Esc keeps the plan from wherever the focus is while the panel is open (a strategy button, Close).
    document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && changingPlan) {
            closePlanPanel();
        }
    });
    els.planCode.addEventListener('input', () => message(''));
    // Plan it (2.5): the event the rider is in, else the next time trial.
    els.nextTtPlan.addEventListener('click', async () => {
        message('');
        try {
            const r = await win.planIt();
            if (r) {
                message(`Plan ${r.code} ready${r.meta?.inputs_source === 'defaults' ? ' (the planner\'s default settings: open the planner to tune them)' : ''}.`, true);
            }
        } catch (err) {
            message(err.message);
        }
    });
    // Plan from here: the rest of the race or route lap, from where the rider is.
    els.fromHerePlan.addEventListener('click', async () => {
        message('');
        try {
            const r = await win.planFromHere();
            if (r) {
                changingPlan = false;
                message(`Plan ${r.code} from here.`, true);
            }
        } catch (err) {
            message(err.message);
        }
        win.draw();
    });
    // A plan from the planner, offered while another is active (TT/RIDE_DAY_PLAN.md 2.4).
    els.toast.addEventListener('click', ev => {
        const action = ev.target.closest('[data-action]')?.dataset.action;
        if (action === 'use-offer') {
            win.useOffer();
        } else if (action === 'dismiss-offer') {
            win.dismissOffer();
        }
    });
}

/** Close the plan panel, keeping the plan. */
function closePlanPanel() {
    changingPlan = false;
    win.draw();
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
    if (wasIdle && !showIdle) {
        message('');       // what the panel last said (a code that did not load) is not kept for its next opening
    }
    wasIdle = showIdle;
    setHidden(els.idle, !showIdle);
    setClass(hud, 'choosing', showIdle);
    const beforeStart = win.beforeStart();
    const link = win.link();
    const linked = link?.state === 'linked';
    if (showIdle) {
        const waiting = !plan && linked ? win.offer() : null;
        setText(els.idleTitle, plan ? `Plan ${plan.code ?? ''}: ${plan.routeName ?? 'custom route'}`
            : waiting ? `Plan ${waiting.code} is ready` : (linked ? 'Waiting for a plan from the planner' : 'Enter your plan code'));
        setText(els.idleHint, !plan
            ? (waiting ? 'It comes up by itself in its pen or on its route. Use loads it now.'
                : linked ? `Optimise a plan in the planner${link.riderName ? ` as ${link.riderName}` : ''}: it comes up in its pen or on its route. Or enter a code.`
                : "The six-letter code from the planner's Share page, or paste its link.")
            : planPanelHint({status: v.status, beforeStart, choose: strategyChoices(plan).length > 1}));
        renderStrategy(plan, v.status === 'finished' ? 'next' : 'now', win.cardWaiting() ? win.chosenCard() : undefined);
    }
    // A pairing waiting for the planner: the code, large, in the panel (2.1).
    const pairing = link?.state === 'pending' && link.code ? link.code : null;
    setHidden(els.pairing, !(showIdle && pairing));
    setText(els.pairingCode, pairing ?? '');
    // The next time trial the rider is signed up for, in the panel while nothing is happening
    // (2.4), or the event the rider is in with no plan for it, with Plan it (2.5).
    const upcoming = win.nextTT();
    const planning = win.planning();
    const planFor = win.planTarget();
    // Once the race is under way, Plan from here plans the rest of it; Plan it (the whole
    // event from the start) is for the pen.
    const here = win.hereOffer(v);
    const inEvent = Boolean(v.event?.inEvent);
    let nextText = '';
    let nextLabel = 'next TT';
    let showPlanIt = false;
    if (planning && !planning.target?.here) {
        nextLabel = 'plan it';
        nextText = `planning ${planning.target?.name ?? 'the event'}… ${Math.round((Date.now() - planning.startedAt) / 1000)} s`;
    } else if (inEvent && !plan && planFor?.inEvent && !(here.offered && here.target.kind === 'event')) {
        nextLabel = 'this event';
        nextText = `${planFor.name ?? v.event?.name ?? 'event'} · no plan yet`;
        showPlanIt = linked;
    } else if (upcoming && !inEvent) {
        nextText = nextWords(upcoming, plan);
        showPlanIt = linked && !upcoming.planCode && Boolean(upcoming.routeId);
    }
    // A newer TT HUD, in the panel too (the banner is hidden behind it).
    const update = updateToShow(v);
    setHidden(els.updateRow, !(showIdle && update));
    setText(els.updateText, update ? `TT HUD v${update.latest} is out` : '');
    setHidden(els.nextTt, !(showIdle && nextText));
    setText(els.nextTtLabel, nextLabel);
    setText(els.nextTtText, nextText);
    setHidden(els.nextTtPlan, !showPlanIt);
    els.nextTtPlan.disabled = Boolean(planning);
    // Plan from here: riding with no plan for this ride (or one for another distance).
    const herePlanning = Boolean(planning?.target?.here);
    let hereText = '';
    if (herePlanning) {
        hereText = `planning ${planning.target.name}… ${Math.round((Date.now() - planning.startedAt) / 1000)} s`;
    } else if (here.offered) {
        hereText = `${here.target.kind === 'event' ? 'to the finish' : 'to the end of the lap'} · ${fmtDistance(here.target.remainingM, true)}`;
    }
    setHidden(els.fromHere, !(showIdle && hereText));
    if (showIdle && !plan && here.offered && !herePlanning) {
        setText(els.idleHint, here.target.kind === 'event'
            ? 'Plan from here plans the rest of the race from where you are, with what your legs have left. Or enter a code.'
            : 'Plan from here plans the rest of this lap from where you are, with what your legs have left. Or enter a code.');
    }
    // A plan from here running: made again from here, it starts from the W' the ride has left now.
    setText(els.fromHereLabel, plan?.fromHere && !herePlanning ? 'again from here' : 'from here');
    setText(els.fromHereText, hereText);
    setHidden(els.fromHerePlan, herePlanning);
    els.fromHerePlan.disabled = Boolean(planning);
    // A plan that arrived for another course or pen: offered before the start, to load by hand
    // (decision 3, revised 2026-11-09), over the plan being ridden or in the empty panel.
    const shelfOffer = win.offer();
    const showToast = Boolean(shelfOffer && (!plan || !showIdle) && beforeStart && !v.spectating);
    setHidden(els.toast, !showToast);
    setClass(hud, 'offering', showToast);
    // The dial has room for a name only: the rest is in the tooltip.
    const offerFull = shelfOffer ? `new plan: ${shelfOffer.routeName ?? shelfOffer.code}${shelfOffer.timeText ? ` · ${shelfOffer.timeText}` : ''}` : '';
    const dial = document.documentElement.dataset.layout === 'dial';
    setText(els.toastText, dial && shelfOffer ? (shelfOffer.routeName ?? shelfOffer.code) : offerFull);
    setAttr(els.toastText, 'title', offerFull);
    // With a plan loaded the × keeps it; with none there is nothing to keep.
    setAttr(els.toastDismiss, 'title', plan ? 'Keep the current plan' : 'Not now');
    setHidden(els.closePanel, !(showIdle && plan));
    setHidden(els.clearPlan, !(showIdle && plan && !v.spectating));
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
        setText(els.nextInS, next.inS != null ? fmtCountdown(next.inS) : '');
        soon = v.status === 'racing' && ((next.inS != null && next.inS <= soonSec) || (next.inM != null && next.inM <= 100));
    } else if (plan && v.status === 'finished') {
        setText(els.nextLabel, 'plan');
        setText(els.nextW, fmtPlanTime(planTimeS(v)));
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
        setText(els.nextInS, target?.toNextS != null && v.status === 'racing' ? fmtCountdown(target.toNextS) : '');
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

    // On the dial the strategy chip labels the plan time before the start ("fastest 14:54"):
    // the time is that strategy's, and the banner above has no room for both.
    const dialChip = document.documentElement.dataset.layout === 'dial' && plan && (v.status === 'armed' || v.status === 'idle')
        && !v.spectating && strategyChoices(plan).length > 1;
    const finishLabel = text => {
        if (dialChip) {
            setHtml(els.finishLabel, `<button type="button" class="chip" data-action="strategy" title="Change the strategy or the plan">${escapeHtml((plan.strategyLabel ?? 'as shared').toLowerCase())}</button>`);
        } else {
            els.finishLabel.__html = null;
            setText(els.finishLabel, text);
        }
    };
    // Finish: the time to go (or, by the setting, the predicted finish time), the plan's time
    // before the start, and the delta from the plan in words.
    if (plan) {
        const fig = finishFigure(v, win.prefs().finishShows);
        finishLabel(fig.label);
        setText(els.finishTime, figureTime(fig));
        const words = (race.running && race.pacingSampleS > 0) || v.status === 'finished' ? deltaWords(race.deltaS) : '';
        setText(els.finishDelta, words);
        setClass(els.finishDelta, 'ahead', words.startsWith('ahead'));
        setClass(els.finishDelta, 'behind', words.startsWith('behind'));
    } else {
        finishLabel('finish');
        setText(els.finishTime, '—');
        setText(els.finishDelta, '');
    }

    // Vitals and progress.
    setText(els.vCadence, live.cadence != null ? String(Math.round(live.cadence)) : '—');
    setText(els.vHr, live.heartrate != null ? String(Math.round(live.heartrate)) : '—');
    setText(els.vSpeed, live.speedKmh != null ? live.speedKmh.toFixed(1) : '—');
    const progress = target && !target.beforePlan ? (target.timeProgress ?? target.progress) * 100 : 0;
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
    els.biasDown.disabled = !canLowerBias(v.controls.bias);

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

/**
 * The strategy buttons: before the start and while racing (in place, when: 'now'); after the
 * finish, for the next ride (when: 'next'). chosen: a choice waiting for the next ride (the
 * store's card, null for as shared), shown pressed; undefined when none waits.
 */
function renderStrategy(plan, when, chosen) {
    const choices = strategyChoices(plan).map(c => (chosen === undefined ? c : {...c, selected: (c.card || null) === (chosen || null)}));
    setHidden(els.strategy, choices.length < 2);
    setText(els.strategyLabel, when === 'next' ? 'strategy (next ride)' : 'strategy');
    const key = `${when}|${choices.map(c => `${c.card}:${c.selected}:${c.timeText}`).join(',')}`;
    if (els.strategyChoices.__key === key) {
        return;
    }
    els.strategyChoices.__key = key;
    els.strategyChoices.innerHTML = choices.map(c => `<button type="button" data-key="${escapeHtml(c.key)}" data-card="${escapeHtml(c.card)}" aria-pressed="${c.selected}"${when === 'next' ? ' title="For the next ride: this one is over"' : ''}>`
        + `${escapeHtml(c.label)} <span class="tnum">${escapeHtml(c.timeText ?? '')}</span></button>`).join('');
}

/** The release page of a newer TT HUD (update-check.mjs), in the browser. */
function openUpdate() {
    const update = win.update();
    if (update) {
        window.open(update.url, '_blank');
    }
}

/** A newer TT HUD, said only while the rider is not racing (Dave, 2026-11-12). */
function updateToShow(v) {
    return v.status !== 'racing' && !v.spectating ? win.update() : null;
}

function setBanner(v, now) {
    const layout = document.documentElement.dataset.layout;
    // The strategy being ridden, as a chip that opens the plan panel: before the start and,
    // since a strategy changes in place, while racing (Dave, 2026-11-09).
    const chip = (v.status === 'armed' || v.status === 'idle' || v.status === 'racing') && !v.spectating && strategyChoices(v.plan).length > 1
        ? `<button type="button" class="chip" data-action="strategy" title="Change the strategy or the plan">${escapeHtml((v.plan.strategyLabel ?? 'as shared').toLowerCase())}</button>` : '';
    const upcoming = v.status === 'idle' && v.plan ? win.nextTT() : null;
    const {text, name, tip} = bannerWords(v, {
        narrow: layout !== 'strip', now,
        idleStatus: v.status === 'idle' ? statusWords(v) : '',
        idleNext: upcoming ? nextWords(upcoming, v.plan, true) : '',
    });
    // A newer TT HUD: a chip after the strategy's, never while racing.
    const update = updateToShow(v);
    const updateChip = update
        ? `<button type="button" class="chip update" data-action="update" title="TT HUD v${escapeHtml(update.latest)} is out: click for the release page">update v${escapeHtml(update.latest)}</button>` : '';
    // The chips before the route name, so a narrow banner cuts the name, not the chips. The stack
    // puts the strategy chip first of all, where no words can push it out of the 230 px; the dial
    // puts the chips above the words (CSS), so they come first there.
    const words = escapeHtml(text);
    const route = `<span class="name">${escapeHtml(name)}</span>`;
    const html = !(text || chip || updateChip) ? ''
        : layout === 'dial' ? `${updateChip}${chip}${words}${route}`
        : layout === 'stack' ? `${chip}${words}${updateChip}${route}`
        : `${words}${chip}${updateChip}${route}`;
    if (els.banner.__html !== html) {
        els.banner.__html = html;
        els.banner.innerHTML = html;
    }
    setAttr(els.banner, 'title', tip);
    setHidden(els.banner, !html);
}

// ---- dial ----

function initDial() {
    setArc(els.dialTrack, 0, 1, DIAL.power);
    setArc(els.dialTimeTrack, 0, 1, DIAL.time);
    setArc(els.dialWbalTrack, 0, 1, DIAL.wbal);
}

function renderDial(v) {
    const plan = v.plan;
    const target = v.target;
    const live = v.live;
    const racing = v.status !== 'finished';
    const maxPower = plan?.peakPowerW > 0 ? Math.ceil(plan.peakPowerW * 1.25) : 600;
    // Power: the live arc in the band colour over the target band, the target as a bold green
    // tick and the next target as a dashed one (amber when the change is seconds away).
    const ratio = racing && live.powerW != null ? clamp(live.powerW / maxPower, 0, 1) : 0;
    setArc(els.dialLive, 0, ratio, DIAL.power);
    setArc(els.dialLiveUnder, 0, ratio, DIAL.power);
    for (const b of ['under', 'on', 'over']) {
        setClass(els.dialLive, `band-${b}`, target?.band === b);
    }
    if (target && racing) {
        const w = win.engine.state.prefs.bandWidthW;
        setArc(els.dialTarget, clamp((target.powerW - w) / maxPower, 0, 1), clamp((target.powerW + w) / maxPower, 0, 1), DIAL.power);
        setTick(els.dialTargetTick, clamp(target.powerW / maxPower, 0, 1), DIAL.power, 12);
    } else {
        setArc(els.dialTarget, 0, 0, DIAL.power);
        setAttr(els.dialTargetTick, 'd', '');
    }
    if (racing && v.next && target && Math.abs(v.next.powerW - target.powerW) > 5) {
        setTick(els.dialNext, clamp(v.next.powerW / maxPower, 0, 1), DIAL.power, 11);
    } else {
        setAttr(els.dialNext, 'd', '');
    }
    // Time left in the interval: full at its start, empty at the change, on the countdown's
    // clock (by distance when there is none); the whole ring before the start, none after
    // the finish.
    const left = !target || !racing ? 0 : target.beforePlan ? 1 : clamp(1 - (target.timeProgress ?? target.progress), 0, 1);
    setArc(els.dialTime, 0, left, DIAL.time);
    // W' left, with the plan's floor.
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

/** "Urumaze 19:20 (in 42 min) · plan ready": the next time trial and whether a plan fits it. */
function nextWords(next, plan, short = false) {
    const when = next.ts ? new Date(next.ts).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
    const minutes = next.ts ? Math.round((next.ts - Date.now()) / 60000) : null;
    const countdown = minutes == null ? '' : minutes < 0 ? 'started' : minutes < 1 ? 'starting now' : minutes < 120 ? `in ${minutes} min` : minutes < 2880 ? `in ${Math.round(minutes / 60)} h` : `in ${Math.round(minutes / 1440)} days`;
    const status = next.planCode ? (plan && next.planCode === plan.code ? 'this plan' : short ? 'plan ready' : `plan ${next.planCode} ready`) : 'no plan yet';
    return `${next.name ?? 'event'} ${when}${countdown ? ` (${countdown})` : ''} · ${status}`;
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
