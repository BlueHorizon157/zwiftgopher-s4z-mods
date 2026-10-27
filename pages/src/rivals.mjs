// The rivals strip (docs/REVAMP_PLAN.md 4.5, Phase 4.4): the riders nearest you on the road,
// ahead and behind, with how far, whether you are gaining or losing time on them over the
// last minute, and their speed over the last sector against yours; below, everyone around
// you placed on a track by their gap on the road.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap, shortName} from './views/field-feed.mjs';
import {rivals as fieldRivals} from './engine/field.mjs';
import {setText, setClass} from './views/dom.mjs';

const RANGES_S = [15, 30, 60, 120, 300, 600];

const els = {};
let win = null;
let feed = null;
const dots = new Map();
let rangeS = 30;

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
    renderSide(els.ahead, r.ahead);
    renderSide(els.behind, r.behind);

    // The track: a range that holds everyone in view, from 15 s up to 10 min each way.
    const far = r.all.reduce((m, x) => Math.max(m, Math.abs(x.roadS)), 0);
    rangeS = RANGES_S.find(x => x >= far) ?? RANGES_S.at(-1);
    setText(els.rangeLeft, `${fmtRange(rangeS)} behind`);
    setText(els.rangeRight, `${fmtRange(rangeS)} ahead`);
    const named = new Set([...r.ahead, ...r.behind].map(x => x.id));
    const seen = new Set();
    for (const x of r.all) {
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
        const cls = `dot${x.trend ? ` trend-${x.trend}` : ''}${named.has(x.id) ? ' named' : ''}${Math.abs(x.roadS) > rangeS ? ' edge' : ''}`;
        if (d.cache.cls !== cls) {
            d.cache.cls = cls;
            d.className = cls;
        }
        const title = `${x.name}: ${fmtGap(x.roadS)} ${x.roadS > 0 ? 'ahead' : 'behind'}`;
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

function renderSide(ol, list) {
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
        put(li, 'nm', c.nm, shortName(x.name));
        put(li, 'gp', c.gp, fmtGap(x.roadS));
        put(li, 'word', c.word, x.trend ?? '');
        put(li, 'rate', c.rate, x.trend && x.trend !== 'holding' ? `${Math.abs(x.gainSPerMin).toFixed(1)} s/min` : '');
        const trCls = `tr${x.trend ? ` trend-${x.trend}` : ''}`;
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
        const title = s ? `${x.name}: ${sc} km/h against your ${Number.isFinite(s.homeKmh) ? s.homeKmh.toFixed(1) : '—'} km/h from ${(s.startM / 1000).toFixed(2)} to ${(s.endM / 1000).toFixed(2)} km` : x.name;
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

function fmtRange(s) {
    return s < 60 ? `${s} s` : `${s / 60} min`;
}
