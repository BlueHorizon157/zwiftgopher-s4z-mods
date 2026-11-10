// The field window (docs/REVAMP_PLAN.md 4.5, Phase 4.2): the riders of your event, each at the
// same distance along the course as you on the clock: the gap now (or at the finish, predicted),
// the place among the riders you can compare with, the distance done (or the time of a rider who
// has finished), the speed, w/kg and W′, and what you gain or lose on each per minute. Riders you
// cannot compare yet sit below a divider with the reason. Rows are keyed by rider and only their
// changed cells are written; the home row stays in view.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap, outlookInputsOf} from './views/field-feed.mjs';
import {rows as fieldRows, drift, gapModeOf, migrateFieldPrefs, GAP_MODES} from './engine/field-model.mjs';
import {finishOutlook} from './engine/finish-outlook.mjs';
import {verdictText, ordinal} from './views/verdict.mjs';
import {setText, setHidden} from './views/dom.mjs';

const MANUAL_SCROLL_HOLD_MS = 5000;
const DIVIDER_ID = '\u0001divider';
const GAP_LABEL = {clock: 'now', finish: 'at the finish'};
const PLACE_TITLE = 'Your place on the clock: how many of the riders you can compare with are ahead of you, '
    + 'each at the same distance along the course. Compared means seen in the last two minutes and past the same point as you';

const els = {};
let win = null;
let feed = null;
const rowEls = new Map();
let holdScrollUntil = 0;
let lastOrder = '';
let prevOutlook = null;      // last render's finish outlook (its states are sticky too)

export function main() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
    const hold = () => { holdScrollUntil = Date.now() + MANUAL_SCROLL_HOLD_MS; };
    els.rows.addEventListener('wheel', hold, {passive: true});
    els.rows.addEventListener('touchstart', hold, {passive: true});
    els.rows.addEventListener('pointerdown', hold);
    els.gapMode.addEventListener('click', () => {
        const next = GAP_MODES[(GAP_MODES.indexOf(gapMode()) + 1) % GAP_MODES.length];
        win.settings?.set('gapMode', next);
        win.draw();
    });
    startWindow({
        render,
        onReady: api => {
            win = api;
            // Settings saved by an earlier version: the road gap is now the gap on the clock.
            for (const [k, v] of Object.entries(migrateFieldPrefs(api.prefs()))) {
                api.settings?.set(k, v);
            }
            feed = startFieldFeed({view: api.view});
            window.zgtt.field = feed.field;
        },
        onReset: () => {
            feed?.reset();
            for (const el of rowEls.values()) {
                el.remove();
            }
            rowEls.clear();
        },
    });
}

function gapMode() {
    return gapModeOf(win?.prefs().gapMode);
}

function render(v) {
    if (!feed) {
        return;
    }
    const prefs = win.prefs();
    const mode = gapMode();
    setText(els.gapMode, GAP_LABEL[mode]);
    const list = fieldRows(feed.field, {
        nowMs: Date.now(),
        allSubgroups: Boolean(prefs.allSubgroups),
        boundaries: boundariesOf(v, win.engine.state.plan),
    });
    // How the finish is shaping up on the clock, at the pace of the last minutes (finish-outlook.mjs).
    const {remainingS, elapsedS, homeFinishS} = outlookInputsOf(v, list);
    const outlook = finishOutlook(list, {remainingS, elapsedS, homeFinishS, prev: prevOutlook});
    prevOutlook = outlook;
    const home = list.find(r => r.isHome) ?? null;
    const settled = Boolean(outlook?.settled);
    const ctx = {mode, outlook, settled, length: feed.field.lengthM};
    // The riders you can compare with, in the order of the gap shown: now (the rows' order) or
    // at the finish (the predicted gap). Riders you cannot compare yet come below a divider.
    const top = list.filter(r => r.isHome || r.comparable).map(r => ({
        ...r,
        shownGapS: r.isHome ? 0 : mode === 'finish' && outlook?.riders.get(r.id) ? outlook.riders.get(r.id).finishGapS : r.gapS,
    }));
    if (mode === 'finish' && outlook) {
        top.sort((a, b) => (b.shownGapS ?? -1e9) - (a.shownGapS ?? -1e9));
    }
    const bottom = list.filter(r => !r.isHome && !r.comparable);
    const items = [...top, ...(bottom.length ? [{id: DIVIDER_ID, divider: true}] : []), ...bottom];

    const others = list.length - (home ? 1 : 0);
    setHidden(els.empty, list.length > 0);
    setText(els.count, list.length ? `${others} ${others === 1 ? 'rider' : 'riders'} ${prefs.allSubgroups ? 'in the event' : 'in your category'}` : '');
    const pl = home?.comparable ? {place: home.place, of: list.filter(r => r.comparable).length} : {place: null, of: null};
    const predicted = settled ? outlook.home.predictedPlace : null;
    let place = '';
    if (home?.finished && home.finishPlace) {
        place = `you finished ${ordinal(home.finishPlace)} of ${home.finishers} so far`;
    } else if (pl.place != null) {
        place = `you ${ordinal(pl.place)} of ${pl.of} compared`;
        if (predicted != null && predicted !== pl.place) {
            place += ` → ${ordinal(predicted)}`;
        }
    }
    setText(els.place, place);
    const placeTitle = `${PLACE_TITLE}${predicted != null && !home?.finished ? '. The arrow is the place you are heading for at the finish, at the pace of the last minutes' : ''}`;
    if (els.place.title !== placeTitle) {
        els.place.title = placeTitle;
    }
    // The verdict: clear, defend, chase or contested, and why (once the outlook is settled).
    const vt = list.length && settled ? verdictText(outlook) : null;
    setHidden(els.verdict, !vt || vt.kind === 'early');
    if (vt && vt.kind !== 'early') {
        setText(els.verdictHead, vt.headline);
        setText(els.verdictDetail, vt.detail);
        const cls = `verdict ${vt.kind}`;
        if (els.verdict.className !== cls) {
            els.verdict.className = cls;
        }
    }

    const seen = new Set();
    for (const r of items) {
        let el = rowEls.get(r.id);
        if (!el) {
            el = r.divider ? makeDivider() : makeRow(r.id);
            rowEls.set(r.id, el);
        }
        seen.add(r.id);
        if (r.divider) {
            continue;
        }
        updateRow(el, r, ctx);
    }
    for (const [id, el] of rowEls) {
        if (!seen.has(id)) {
            el.remove();
            rowEls.delete(id);
        }
    }
    const order = items.map(r => r.id).join(',');
    if (order !== lastOrder) {
        lastOrder = order;
        // Move only the rows that are out of place.
        items.forEach((r, i) => {
            const el = rowEls.get(r.id);
            if (els.rows.children[i] !== el) {
                els.rows.insertBefore(el, els.rows.children[i] ?? null);
            }
        });
    }
    keepHomeInView();
}

function makeRow(id) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = id;
    el.innerHTML = '<span class="c pos"></span><span class="c name"><span></span><small></small></span>'
        + '<span class="c gap"><i class="glyph"></i><span></span></span><span class="c trend"></span>'
        + '<span class="c dist"><small></small><b></b></span>'
        + '<span class="c kmh"></span><span class="c wkg"></span><span class="c wbal"><span class="wbar"><i></i></span></span>';
    const [pos, name, gap, trend, dist, kmh, wkg, wbal] = el.children;
    el.cells = {pos, name: name.children[0], team: name.children[1], glyph: gap.firstChild, gap: gap.lastChild, trend,
        distSmall: dist.firstChild, distVal: dist.lastChild, kmh, wkg, bar: wbal.firstChild};
    el.cache = {};
    return el;
}

function makeDivider() {
    const el = document.createElement('div');
    el.className = 'divider';
    el.textContent = 'not compared yet';
    el.title = 'Riders you cannot compare with yet: not started, no shared point yet, or not seen for two minutes';
    el.cache = {};
    return el;
}

function put(el, key, node, text) {
    if (el.cache[key] !== text) {
        el.cache[key] = text;
        node.textContent = text;
    }
}

/**
 * The place a row shows in the pos column: at the finish (predicted) in that mode; else the place
 * now, like for like, for every row (a finisher's finish place is in its finish cell, not here, so
 * the column is one numbering and reads in order).
 */
function posOf(r, ctx) {
    if (ctx.mode === 'finish' && ctx.settled) {
        return r.isHome ? ctx.outlook.home.predictedPlace : (ctx.outlook.riders.get(r.id)?.place ?? null);
    }
    return r.comparable ? r.place : null;
}

function updateRow(el, r, ctx) {
    const c = el.cells;
    const x = r.isHome ? null : ctx.outlook?.riders.get(r.id) ?? null;
    const fin = Boolean(r.finished);
    // Riders who finish nowhere near you (clear) fade back; a prediction from a short history is faint.
    const early = ctx.mode === 'finish' && (!ctx.settled || Boolean(x?.early));
    const clear = ctx.mode === 'finish' && ctx.settled && x?.state === 'clear' && !fin;
    const cls = `row${r.isHome ? ' home' : ''}${r.stale ? ' stale' : ''}${!r.comparable && !r.isHome ? ' apart' : ''}${!r.started ? ' waiting' : ''}${fin ? ' finished' : ''}${clear ? ' clear' : ''}${early ? ' early' : ''}`;
    if (el.cache.cls !== cls) {
        el.cache.cls = cls;
        el.className = cls;
    }
    const pos = posOf(r, ctx);
    put(el, 'pos', c.pos, pos != null ? String(pos) : '');
    put(el, 'name', c.name, r.isHome ? 'you' : r.name);
    // A rider you cannot compare yet says why, where the team would be.
    put(el, 'team', c.team, !r.isHome && !r.comparable ? (r.reason ?? '') : (r.isHome ? '' : (r.team ?? '')));
    const sign = r.isHome || !r.comparable ? null : (ctx.mode === 'finish' && x ? x.finishGapS : r.gapS);
    if (Number.isFinite(sign)) {
        // ▲ the rider is ahead of you on the clock, ▼ behind.
        put(el, 'glyph', c.glyph, Math.abs(sign) < 0.05 ? '' : sign > 0 ? '▲' : '▼');
        put(el, 'gap', c.gap, fmtGap(sign));
    } else {
        put(el, 'glyph', c.glyph, '');
        put(el, 'gap', c.gap, '');
    }
    const dr = r.isHome || fin || !r.comparable ? null : drift(r);
    const trendText = dr == null ? '' : dr.word === 'holding' ? 'hold' : `${dr.word === 'gaining' ? '+' : '−'}${Math.abs(dr.sPerMin).toFixed(1)} s`;
    put(el, 'trend', c.trend, trendText);
    const trendCls = `c trend${dr ? ` trend-${dr.word}` : ''}`;
    if (el.cache.trendCls !== trendCls) {
        el.cache.trendCls = trendCls;
        c.trend.className = trendCls;
    }
    const trendTitle = dr == null ? '' : dr.word === 'holding'
        ? `You hold ${r.name} (under 0.3 s a minute either way) over the last ${dr.sustained ? 'four minutes' : 'minute'}`
        : `You ${dr.word === 'gaining' ? 'gain' : 'lose'} ${Math.abs(dr.sPerMin).toFixed(1)} s a minute on ${r.name} over the last ${dr.sustained ? 'four minutes' : 'minute'}`;
    if (el.cache.trendTitle !== trendTitle) {
        el.cache.trendTitle = trendTitle;
        c.trend.title = trendTitle;
    }
    // Distance done in km; a rider who has finished shows the time they finished in.
    if (fin) {
        put(el, 'distSmall', c.distSmall, r.finishPlace ? `finished ${ordinal(r.finishPlace)}` : 'finished');
        put(el, 'distVal', c.distVal, Number.isFinite(r.finishRaceS) ? fmtClock(r.finishRaceS) : '');
    } else {
        put(el, 'distSmall', c.distSmall, '');
        put(el, 'distVal', c.distVal, Number.isFinite(r.distanceM) ? (r.distanceM / 1000).toFixed(1) : '');
    }
    const pct = Number.isFinite(r.distanceM) && ctx.length > 0 ? Math.min(100, r.distanceM / ctx.length * 100) : null;
    const distTitle = fin
        ? `${r.isHome ? 'You' : r.name} finished in ${Number.isFinite(r.finishRaceS) ? fmtClock(r.finishRaceS) : 'a time not seen'}${r.finishPlace ? `, ${ordinal(r.finishPlace)} of ${r.finishers} finished so far` : ''}`
        : Number.isFinite(r.distanceM) ? `${(r.distanceM / 1000).toFixed(1)} km done${pct != null ? `, ${pct.toFixed(0)} % of the event` : ''}` : '';
    if (el.cache.distTitle !== distTitle) {
        el.cache.distTitle = distTitle;
        c.distVal.parentNode.title = distTitle;
    }
    put(el, 'kmh', c.kmh, Number.isFinite(r.avgKmh) ? r.avgKmh.toFixed(1) : '');
    put(el, 'wkg', c.wkg, Number.isFinite(r.wkg) ? r.wkg.toFixed(2) : '');
    const w = Number.isFinite(r.wbalPct) ? `${Math.max(0, Math.min(100, r.wbalPct)).toFixed(0)}%` : '0%';
    if (el.cache.w !== w) {
        el.cache.w = w;
        c.bar.style.setProperty('--w', w);
        c.bar.classList.toggle('low', Number.isFinite(r.wbalPct) && r.wbalPct < 25);
        c.bar.title = Number.isFinite(r.wbalKj) ? `${r.wbalKj.toFixed(1)} kJ` : '';
    }
    let rowTitle = '';
    if (fin && Number.isFinite(r.finishRaceS)) {
        rowTitle = `${r.isHome ? 'You' : r.name} finished in ${fmtClock(r.finishRaceS)}`;
    } else if (fin) {
        rowTitle = `${r.isHome ? 'You' : r.name} finished, time not seen`;
    } else if (x && ctx.settled && Number.isFinite(x.finishS)) {
        rowTitle = `${r.name}: finishes in about ${fmtClock(x.finishS)} at the pace of the last minutes`;
    }
    if (el.title !== rowTitle) {
        el.title = rowTitle;
    }
}

function keepHomeInView() {
    if (Date.now() < holdScrollUntil) {
        return;
    }
    const home = els.rows.querySelector('.row.home');
    if (!home) {
        return;
    }
    const c = els.rows;
    const target = home.offsetTop - c.clientHeight / 2 + home.offsetHeight / 2;
    const next = Math.max(0, Math.min(target, c.scrollHeight - c.clientHeight));
    if (Math.abs(c.scrollTop - next) > 2) {
        c.scrollTop = next;
    }
}

function fmtClock(s) {
    const t = Math.max(0, Math.round(s));
    const m = Math.floor(t / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${m}:${String(t % 60).padStart(2, '0')}`;
}
