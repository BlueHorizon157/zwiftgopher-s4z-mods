// The field window (docs/REVAMP_PLAN.md 4.5, Phase 4.2): the riders of your event, ordered
// by the gap at equal distance (on the clock or on the road), with what you gain or lose on
// each per minute, their average speed, w/kg and W′. Rows are keyed by rider and only their
// changed cells are written; the home row stays in view.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap} from './views/field-feed.mjs';
import {rows as fieldRows} from './engine/field.mjs';
import {setText, setHidden} from './views/dom.mjs';

const MANUAL_SCROLL_HOLD_MS = 5000;

const els = {};
let win = null;
let feed = null;
const rowEls = new Map();
let holdScrollUntil = 0;
let lastOrder = '';

export function main() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
    const hold = () => { holdScrollUntil = Date.now() + MANUAL_SCROLL_HOLD_MS; };
    els.rows.addEventListener('wheel', hold, {passive: true});
    els.rows.addEventListener('touchstart', hold, {passive: true});
    els.rows.addEventListener('pointerdown', hold);
    els.gapMode.addEventListener('click', () => {
        const next = gapMode() === 'road' ? 'clock' : 'road';
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

function gapMode() {
    return win?.prefs().gapMode === 'road' ? 'road' : 'clock';
}

function render(v) {
    if (!feed) {
        return;
    }
    const prefs = win.prefs();
    const mode = gapMode();
    setText(els.gapMode, mode === 'road' ? 'road gap' : 'gap');
    const list = fieldRows(feed.field, {
        nowMs: Date.now(),
        allSubgroups: Boolean(prefs.allSubgroups),
        boundaries: boundariesOf(v, win.engine.state.plan),
        gapMode: mode,
    });
    const home = list.find(r => r.isHome);
    const others = list.length - (home ? 1 : 0);
    setHidden(els.empty, list.length > 0);
    setText(els.count, list.length ? `${others} ${others === 1 ? 'rider' : 'riders'} ${prefs.allSubgroups ? 'in the event' : 'in your category'}` : '');
    setText(els.place, home?.position ? `you ${ordinal(home.position)}${home.participants ? ` of ${home.participants}` : ''}` : '');

    const seen = new Set();
    for (const r of list) {
        seen.add(r.id);
        let el = rowEls.get(r.id);
        if (!el) {
            el = makeRow(r.id);
            rowEls.set(r.id, el);
        }
        updateRow(el, r);
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
    el.innerHTML = '<span class="c pos"></span><span class="c name"><span></span><small></small></span>'
        + '<span class="c gap"><i class="glyph"></i><span></span></span><span class="c trend"></span>'
        + '<span class="c kmh"></span><span class="c wkg"></span><span class="c wbal"><span class="wbar"><i></i></span></span>';
    const [pos, name, gap, trend, kmh, wkg, wbal] = el.children;
    el.cells = {pos, name: name.firstChild, team: name.lastChild, glyph: gap.firstChild, gap: gap.lastChild, trend, kmh, wkg, bar: wbal.firstChild};
    el.cache = {};
    return el;
}

function put(el, key, node, text) {
    if (el.cache[key] !== text) {
        el.cache[key] = text;
        node.textContent = text;
    }
}

function updateRow(el, r) {
    const c = el.cells;
    const cls = `row${r.isHome ? ' home' : ''}${r.stale ? ' stale' : ''}${!r.started ? ' waiting' : ''}`;
    if (el.cache.cls !== cls) {
        el.cache.cls = cls;
        el.className = cls;
    }
    put(el, 'pos', c.pos, r.position ? String(r.position) : '');
    put(el, 'name', c.name, r.isHome ? 'you' : r.name);
    put(el, 'team', c.team, r.isHome ? '' : (r.team ?? ''));
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
    const trendText = r.trend == null ? '' : r.trend === 'holding' ? 'hold' : `${r.trend === 'gaining' ? '+' : '−'}${Math.abs(r.gainSPerMin).toFixed(1)} s`;
    put(el, 'trend', c.trend, trendText);
    const trendCls = `c trend${r.trend ? ` trend-${r.trend}` : ''}`;
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

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
