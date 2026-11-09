// The field window (docs/REVAMP_PLAN.md 4.5, Phase 4.2): the riders of your event, ordered
// by the gap at equal distance (on the clock or on the road), with what you gain or lose on
// each per minute, their average speed, w/kg and W′. Rows are keyed by rider and only their
// changed cells are written; the home row stays in view.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap} from './views/field-feed.mjs';
import {rows as fieldRows, playSet, drift} from './engine/field-model.mjs';
import {finishOutlook} from './engine/finish-outlook.mjs';
import {verdictText, clockTag, ordinal} from './views/verdict.mjs';
import {remainingOf} from './views/race-time.mjs';
import {setText, setHidden} from './views/dom.mjs';

const MANUAL_SCROLL_HOLD_MS = 5000;

const els = {};
let win = null;
let feed = null;
const rowEls = new Map();
let holdScrollUntil = 0;
let lastOrder = '';
let prevPlay = null;         // last render's road play set (in play and near are sticky, playSet)
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

const GAP_MODES = ['clock', 'finish', 'road'];
const GAP_LABEL = {clock: 'gap', finish: 'at finish', road: 'road gap'};

function gapMode() {
    const m = win?.prefs().gapMode;
    return GAP_MODES.includes(m) ? m : 'clock';
}

function render(v) {
    if (!feed) {
        return;
    }
    const prefs = win.prefs();
    const mode = gapMode();
    setText(els.gapMode, GAP_LABEL[mode]);
    let list = fieldRows(feed.field, {
        nowMs: Date.now(),
        allSubgroups: Boolean(prefs.allSubgroups),
        boundaries: boundariesOf(v, win.engine.state.plan),
        gapMode: mode === 'road' ? 'road' : 'clock',
    });
    const home = list.find(r => r.isHome);
    // How the finish is shaping up on the clock, at the pace of the last minutes (finish-outlook.mjs).
    const remainingS = remainingOf(v);
    const homeFinishS = v.race?.running && Number.isFinite(v.race.elapsedS) && Number.isFinite(remainingS) ? v.race.elapsedS + remainingS : null;
    const outlook = finishOutlook(list, {remainingS, homeFinishS, homePosition: home?.position, prev: prevOutlook});
    prevOutlook = outlook;
    // On the road: who you catch, or who catches you, before the finish, and who is close on the road at it.
    const play = mode === 'road'
        ? playSet(list.filter(r => !r.isHome && Number.isFinite(r.gapS)).map(r => ({id: r.id, roadS: r.gapS, paceSPerMin: r.paceSPerMin})), {remainingS, prev: prevPlay})
        : null;
    prevPlay = play;
    // At finish: the gap each rider is predicted to finish at, in that order.
    if (mode === 'finish' && outlook) {
        list = list.map(r => (r.isHome ? r : {...r, gapS: outlook.riders.get(r.id)?.finishGapS ?? null}))
            .sort((a, b) => (b.isHome ? 0 : b.gapS ?? -1e9) - (a.isHome ? 0 : a.gapS ?? -1e9));
    }
    const ctx = {mode, outlook, play, faint: !outlook || outlook.verdict.kind === 'early' || outlook.verdict.kind === 'done'};
    const others = list.length - (home ? 1 : 0);
    setHidden(els.empty, list.length > 0);
    setText(els.count, list.length ? `${others} ${others === 1 ? 'rider' : 'riders'} ${prefs.allSubgroups ? 'in the event' : 'in your category'}` : '');
    const pred = outlook?.home.predictedPlace;
    const place = home?.position
        ? `you ${ordinal(home.position)}${pred && pred !== home.position && !ctx.faint ? ` → ${ordinal(pred)}` : ''}${home.participants ? ` of ${home.participants}` : ''}`
        : '';
    setText(els.place, place);
    const finishAt = Number.isFinite(homeFinishS) ? `; you finish in about ${fmtClock(homeFinishS)}` : '';
    if (els.place.title !== `Your place now${pred ? ', and at the pace of the last minutes at the finish' : ''}${finishAt}`) {
        els.place.title = `Your place now${pred ? ', and at the pace of the last minutes at the finish' : ''}${finishAt}`;
    }
    // The verdict: clear, defend, chase or contested, and why.
    const vt = list.length ? verdictText(outlook) : null;
    setHidden(els.verdict, !vt);
    if (vt) {
        setText(els.verdictHead, vt.headline);
        setText(els.verdictDetail, vt.detail);
        const cls = `verdict ${vt.kind}`;
        if (els.verdict.className !== cls) {
            els.verdict.className = cls;
        }
    }

    const seen = new Set();
    for (const r of list) {
        seen.add(r.id);
        let el = rowEls.get(r.id);
        if (!el) {
            el = makeRow(r.id);
            rowEls.set(r.id, el);
        }
        updateRow(el, r, ctx);
    }
    for (const [id, el] of rowEls) {
        if (!seen.has(id)) {
            el.remove();
            rowEls.delete(id);
        }
    }
    const order = list.map(r => r.id).join(',');
    if (order !== lastOrder) {
        lastOrder = order;
        // Move only the rows that are out of place.
        list.forEach((r, i) => {
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
    el.innerHTML = '<span class="c pos"></span><span class="c name"><span></span><b class="play none"><i></i><span></span></b><small></small></span>'
        + '<span class="c gap"><i class="glyph"></i><span></span></span><span class="c trend"></span>'
        + '<span class="c kmh"></span><span class="c wkg"></span><span class="c wbal"><span class="wbar"><i></i></span></span>';
    const [pos, name, gap, trend, kmh, wkg, wbal] = el.children;
    el.cells = {pos, name: name.children[0], play: name.children[1], playWord: name.children[1].firstChild, playVal: name.children[1].lastChild, team: name.children[2], glyph: gap.firstChild, gap: gap.lastChild, trend, kmh, wkg, bar: wbal.firstChild};
    el.cache = {};
    return el;
}

function put(el, key, node, text) {
    if (el.cache[key] !== text) {
        el.cache[key] = text;
        node.textContent = text;
    }
}

function updateRow(el, r, ctx) {
    const c = el.cells;
    const x = r.isHome ? null : ctx.outlook?.riders.get(r.id);
    // Riders who finish nowhere near you (clear) fade back; predictions from a short history are faint.
    const clear = !ctx.faint && x?.state === 'clear';
    const cls = `row${r.isHome ? ' home' : ''}${r.stale ? ' stale' : ''}${!r.started ? ' waiting' : ''}${clear ? ' clear' : ''}${ctx.mode === 'finish' && (x?.early || ctx.faint) ? ' early' : ''}`;
    if (el.cache.cls !== cls) {
        el.cache.cls = cls;
        el.className = cls;
    }
    const finishPlace = ctx.mode === 'finish' && !ctx.faint ? (r.isHome ? ctx.outlook?.home.predictedPlace : x?.place) : null;
    put(el, 'pos', c.pos, finishPlace ? String(finishPlace) : ctx.mode !== 'finish' && r.position ? String(r.position) : '');
    put(el, 'name', c.name, r.isHome ? 'you' : r.name);
    put(el, 'team', c.team, r.isHome ? '' : (r.team ?? ''));
    // The tag, at the pace of the last minutes. On the road: catch / catches you before the
    // finish (with when), in reach / pressure when close on the road at it. On the clock: you
    // beat / beats you, in reach / pressure.
    let tag = '';
    let word = '';
    let val = '';
    if (ctx.play) {
        const meet = ctx.play.inPlay.has(r.id) ? ctx.play.meetS.get(r.id) : null;
        const near = meet == null ? ctx.play.near.get(r.id) : null;
        tag = meet != null ? (r.gapS > 0 ? 'catch' : 'caught') : near ? near.kind : '';
        [word, val] = {catch: ['catch', fmtClock(meet)], caught: ['catches you', fmtClock(meet)],
            reach: ['in reach', near ? fmtFinishGap(near.finishGapS) : ''], pressure: ['pressure', near ? fmtFinishGap(near.finishGapS) : ''], '': ['', '']}[tag];
    } else if (x && !ctx.faint && x.state !== 'clear') {
        tag = {beat: 'catch', beaten: 'caught', reach: 'reach', pressure: 'pressure'}[x.state];
        [word, val] = clockTag(x);
    }
    put(el, 'playWord', c.playWord, word);
    put(el, 'playVal', c.playVal, val);
    const playCls = `play${tag ? ` ${tag}${val ? ' has-val' : ''}` : ' none'}`;
    const road = Boolean(ctx.play);
    if (el.cache.playCls !== `${playCls}${road}`) {
        el.cache.playCls = `${playCls}${road}`;
        c.play.className = playCls;
        c.name.parentNode.classList.toggle('tagged', Boolean(tag));
        const pace = 'At the pace of the last minutes';
        c.play.title = {
            catch: road ? `${pace} you catch this rider on the road before the finish` : `${pace} you finish ahead of this rider on time, by this much`,
            caught: road ? `${pace} this rider catches you on the road before the finish` : `${pace} this rider finishes ahead of you on time, by this much`,
            reach: `${pace} this rider finishes just ahead of you${road ? ' on the road' : ' on time'}: a little more from you, or a fade from them, and you are past`,
            pressure: `${pace} this rider finishes just behind you${road ? ' on the road' : ' on time'}`,
            '': '',
        }[tag];
    }
    const rowTitle = x && Number.isFinite(x.finishS) ? `${r.name}: finishes in about ${fmtClock(x.finishS)} at the pace of the last minutes` : '';
    if (el.title !== rowTitle) {
        el.title = rowTitle;
    }
    if (r.isHome) {
        put(el, 'glyph', c.glyph, '');
        put(el, 'gap', c.gap, '');
    } else if (!r.started) {
        put(el, 'glyph', c.glyph, '');
        put(el, 'gap', c.gap, 'not started');
    } else if (Number.isFinite(r.gapS)) {
        // ▲ the rider is ahead of you (faster on the clock, or up the road), ▼ behind.
        put(el, 'glyph', c.glyph, Math.abs(r.gapS) < 0.05 ? '' : r.gapS > 0 ? '▲' : '▼');
        put(el, 'gap', c.gap, fmtGap(r.gapS));
    } else {
        put(el, 'glyph', c.glyph, '');
        put(el, 'gap', c.gap, '');
    }
    const dr = r.isHome ? null : drift(r);
    const trendText = dr == null ? '' : dr.word === 'holding' ? 'hold' : `${dr.word === 'gaining' ? '+' : '−'}${Math.abs(dr.sPerMin).toFixed(1)} s`;
    put(el, 'trend', c.trend, trendText);
    const trendCls = `c trend${dr ? ` trend-${dr.word}` : ''}`;
    if (el.cache.trendCls !== trendCls) {
        el.cache.trendCls = trendCls;
        c.trend.className = trendCls;
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

/** A gap at the finish for the tags: "<1 s", "8 s". */
function fmtFinishGap(s) {
    const a = Math.abs(s);
    return a < 1 ? '<1 s' : `${Math.round(a)} s`;
}

function fmtClock(s) {
    const t = Math.max(0, Math.round(s));
    const m = Math.floor(t / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${m}:${String(t % 60).padStart(2, '0')}`;
}

