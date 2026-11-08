// The rivals strip (docs/REVAMP_PLAN.md 4.5, Phase 4.4): the riders that matter around you on
// the road, ahead and behind: how far, and how it ends at the pace of the last minutes (you
// catch them, they catch you, close at the finish, or the gap's drift), with their speed over
// the last sector against yours; below, everyone around you placed on a track by their gap.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap, shortName} from './views/field-feed.mjs';
import {rivals as fieldRivals, trackScale, drift, TRACK_MODES} from './engine/field-model.mjs';
import {setText, setClass} from './views/dom.mjs';

const els = {};
let win = null;
let feed = null;
const dots = new Map();
let rangeS = 30;
let prevPlay = null;         // last render's play set: in play and near are sticky (playSet)

export function main() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
    startWindow({
        render,
        onReady: api => {
            win = api;
            feed = startFieldFeed({view: api.view});
            window.zgtt.field = feed.field;
        },
        onReset: () => {
            feed?.reset();
            for (const d of dots.values()) {
                d.remove();
            }
            dots.clear();
        },
    });
}

function render(v) {
    if (!feed) {
        return;
    }
    const each = Math.max(1, Math.min(2, Number(win.prefs().rivalsEach) || 2));
    const r = fieldRivals(feed.field, {nowMs: Date.now(), each, boundaries: boundariesOf(v, win.engine.state.plan)});
    setClass(els.rivals, 'alone', r.all.length === 0);
    setText(els.meSpeed, Number.isFinite(r.home?.speedKmh) ? r.home.speedKmh.toFixed(1) : '—');
    const mode = TRACK_MODES.includes(String(win.prefs().rivalsRange)) ? String(win.prefs().rivalsRange) : 'play';
    const remainingS = v.race?.running ? v.race.remainingS : (v.race?.planTimeFromStartS ?? null);
    const t = trackScale(r.all, {mode, remainingS, prev: prevPlay});
    prevPlay = t;
    renderSide(els.ahead, pick(r.all.filter(x => x.roadS > 0).sort((a, b) => a.roadS - b.roadS), each, t), t);
    renderSide(els.behind, pick(r.all.filter(x => x.roadS <= 0).sort((a, b) => b.roadS - a.roadS), each, t), t);

    // The track (settings → Rivals → Track range): by default ±1 min, wider to hold the riders
    // in play (you catch them, or they catch you, before the finish at the current trend); or a
    // fixed range; or the whole field. Riders beyond it are counted at the ends.
    // The ends: the range, the riders beyond it, and how many you catch / catch you before the finish.
    rangeS = t.rangeS;
    setText(els.rangeLeft, [t.hiddenBehind ? `+${t.hiddenBehind}` : '', `${fmtRange(rangeS)} behind`, t.caught.size ? `${t.caught.size} catch${t.caught.size === 1 ? 'es' : ''} you` : ''].filter(Boolean).join(' · '));
    setText(els.rangeRight, [t.catching.size ? `you catch ${t.catching.size}` : '', `${fmtRange(rangeS)} ahead`, t.hiddenAhead ? `+${t.hiddenAhead}` : ''].filter(Boolean).join(' · '));
    setClass(els.rangeLeft, 'warn', t.caught.size > 0);
    setClass(els.rangeRight, 'good', t.catching.size > 0);
    const named = new Set([...els.ahead.children, ...els.behind.children].map(li => li.riderId));
    const seen = new Set();
    for (const x of t.shown) {
        seen.add(x.id);
        let d = dots.get(x.id);
        if (!d) {
            d = document.createElement('i');
            d.cache = {};
            dots.set(x.id, d);
            els.lane.append(d);
        }
        const clamped = Math.max(-rangeS, Math.min(rangeS, x.roadS));
        const left = `${(50 + clamped / rangeS * 50).toFixed(2)}%`;
        if (d.cache.left !== left) {
            d.cache.left = left;
            d.style.left = left;
        }
        const dr = drift(x);
        const cls = `dot${dr ? ` trend-${dr.word}` : ''}${named.has(x.id) ? ' named' : ''}${t.inPlay.has(x.id) ? ' in-play' : t.near.has(x.id) ? ' near' : ''}`;
        if (d.cache.cls !== cls) {
            d.cache.cls = cls;
            d.className = cls;
        }
        const title = `${x.name}: ${fmtGap(x.roadS)} ${x.roadS > 0 ? 'ahead' : 'behind'}${outlookTitle(x, t)}`;
        if (d.title !== title) {
            d.title = title;
        }
    }
    for (const [id, d] of dots) {
        if (!seen.has(id)) {
            d.remove();
            dots.delete(id);
        }
    }
}

/**
 * The riders to name on a side, nearest first: the nearest on the road always, then the
 * nearest that matters (in play or close at the finish), else the next nearest.
 */
function pick(side, each, t) {
    const out = side.slice(0, 1);
    if (each > 1 && side.length > 1) {
        out.push(side.slice(1).find(x => t.inPlay.has(x.id) || t.near.has(x.id)) ?? side[1]);
    }
    return out;
}

/**
 * How it goes with a rider to the finish, at the pace of the last minutes: {tag: 'catch' |
 * 'caught' | 'reach' | 'pressure', text} for the riders that matter, else the drift.
 */
function outlook(x, t) {
    if (t.inPlay.has(x.id)) {
        const at = fmtClock(t.meetS.get(x.id));
        return x.roadS > 0 ? {tag: 'catch', text: `catch ${at}`} : {tag: 'caught', text: `catches you ${at}`};
    }
    const n = t.near.get(x.id);
    if (n) {
        const g = Math.abs(n.finishGapS) < 1 ? '<1 s' : `${Math.round(Math.abs(n.finishGapS))} s`;
        return n.kind === 'reach' ? {tag: 'reach', text: `in reach ${g}`} : {tag: 'pressure', text: `pressure ${g}`};
    }
    return null;
}

function outlookTitle(x, t) {
    const pace = 'at the pace of the last minutes';
    if (t.inPlay.has(x.id)) {
        return `; ${pace} ${x.roadS > 0 ? 'you catch them' : 'they catch you'} in ${fmtClock(t.meetS.get(x.id))}`;
    }
    const n = t.near.get(x.id);
    if (!n) {
        return '';
    }
    const g = `${Math.abs(n.finishGapS).toFixed(0)} s`;
    return n.kind === 'reach'
        ? `; ${pace} they finish ${g} ahead of you: ${n.needSPerMin.toFixed(1)} s/min more, from you or from them fading, catches them`
        : `; ${pace} they finish ${g} behind you: ${n.needSPerMin.toFixed(1)} s/min more from them catches you`;
}

function renderSide(ol, list, t) {
    while (ol.children.length < list.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="nm"></span><span class="gp"></span><span class="tr"><span class="word"></span> <span class="rate"></span></span><span class="sc"></span>';
        const [nm, gp, tr, sc] = li.children;
        li.cells = {nm, gp, tr, word: tr.firstChild, rate: tr.lastChild, sc};
        li.cache = {};
        ol.append(li);
    }
    while (ol.children.length > list.length) {
        ol.lastChild.remove();
    }
    list.forEach((x, i) => {
        const li = ol.children[i];
        const c = li.cells;
        li.riderId = x.id;
        put(li, 'nm', c.nm, shortName(x.name));
        put(li, 'gp', c.gp, fmtGap(x.roadS));
        // How it ends with them (a tag), else which way the gap drifts, over the last minutes.
        const o = outlook(x, t);
        const dr = drift(x);
        if (o) {
            put(li, 'word', c.word, o.text);
            put(li, 'rate', c.rate, '');
        } else {
            put(li, 'word', c.word, dr?.word ?? '');
            put(li, 'rate', c.rate, dr && dr.word !== 'holding' ? `${Math.abs(dr.sPerMin).toFixed(1)} s/min` : '');
        }
        const trCls = o ? `tr tag ${o.tag}` : `tr${dr ? ` trend-${dr.word}` : ''}`;
        if (li.cache.trCls !== trCls) {
            li.cache.trCls = trCls;
            c.tr.className = trCls;
        }
        // Their speed over the last sector both of you rode, coloured by who was faster.
        const s = x.sector;
        const sc = s && Number.isFinite(s.riderKmh) ? s.riderKmh.toFixed(1) : '';
        put(li, 'sc', c.sc, sc);
        const scCls = `sc${s && Number.isFinite(s.homeKmh) && Number.isFinite(s.riderKmh) && Math.abs(s.homeKmh - s.riderKmh) >= 0.1 ? (s.riderKmh < s.homeKmh ? ' trend-gaining' : ' trend-losing') : ''}`;
        if (li.cache.scCls !== scCls) {
            li.cache.scCls = scCls;
            c.sc.className = scCls;
        }
        const title = `${x.name}${outlookTitle(x, t)}${s ? `. ${sc} km/h against your ${Number.isFinite(s.homeKmh) ? s.homeKmh.toFixed(1) : '—'} km/h from ${(s.startM / 1000).toFixed(2)} to ${(s.endM / 1000).toFixed(2)} km` : ''}`;
        if (li.title !== title) {
            li.title = title;
        }
    });
}

function put(el, key, node, text) {
    if (el.cache[key] !== text) {
        el.cache[key] = text;
        node.textContent = text;
    }
}

/** "4:10", "12:05", "1:02:45". */
function fmtClock(s) {
    const t = Math.max(0, Math.round(s));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function fmtRange(s) {
    return s < 60 ? `${s} s` : `${+(s / 60).toFixed(1)} min`;
}
