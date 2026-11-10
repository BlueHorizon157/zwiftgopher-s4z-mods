// The rivals strip (docs/REVAMP_PLAN.md 4.5, Phase 4.4): the riders nearest you on the clock,
// ahead and behind, at the same distance along the course as you: how far (the gap now) and how
// fast the gap moves (the last minutes). In the middle your place among the riders you can
// compare with, and the verdict on the finish once the outlook is settled (finish-outlook.mjs).
// Below, every comparable rider on a track by the same gap. Colour is for the riders in play
// only (Dave, 2026-11-10), on the dot and the name: green a target (ahead, and you beat them or
// finish close at this pace), red a threat (behind, and they beat you or finish close); everyone
// else stays plain. The call comes from the finish outlook, needs the rider's pace (90 s of
// shared history), and is faint until the outlook settles. The rate keeps its sign and no colour.
import {startWindow} from './views/runtime.mjs';
import {startFieldFeed, boundariesOf, fmtGap, shortName, outlookInputsOf, playCall, playWords} from './views/field-feed.mjs';
import {rows as fieldRows, rivalsOf, trackScale, trackRangeOf, drift, migrateFieldPrefs} from './engine/field-model.mjs';
import {setText, setClass} from './views/dom.mjs';
import {finishOutlook} from './engine/finish-outlook.mjs';
import {verdictText, ordinal} from './views/verdict.mjs';

const els = {};
let win = null;
let feed = null;
const dots = new Map();
let prevOutlook = null;      // last render's finish outlook (sticky states too)

export function main() {
    for (const el of document.querySelectorAll('[id]')) {
        els[el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el;
    }
    startWindow({
        render,
        onReady: api => {
            win = api;
            // Settings saved by an earlier version: the 'play' range is now one minute.
            for (const [k, v] of Object.entries(migrateFieldPrefs(api.prefs()))) {
                api.settings?.set(k, v);
            }
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
    const list = fieldRows(feed.field, {nowMs: Date.now(), boundaries: boundariesOf(v, win.engine.state.plan)});
    const {remainingS, elapsedS, homeFinishS} = outlookInputsOf(v, list);
    const o = finishOutlook(list, {remainingS, elapsedS, homeFinishS, prev: prevOutlook});
    prevOutlook = o;
    const rv = rivalsOf(list, {each});
    setClass(els.rivals, 'alone', rv.all.length === 0);
    const mode = trackRangeOf(win.prefs().rivalsRange);
    const t = trackScale(rv.all, {mode});
    renderMe(o, rv, v);
    // Targets and threats are for a race you are still in: once you have finished, nobody is called.
    const calls = rv.home?.finished ? null : o;
    const named = new Set([...renderSide(els.ahead, rv.ahead, calls), ...renderSide(els.behind, rv.behind, calls)]);

    // The track (settings → Rivals → Track range): ±1 min by default, or ±30 s, ±2 min, ±5 min,
    // or the whole field. Riders beyond it are counted at the ends.
    const word = rangeWord(mode, t.rangeS);
    setText(els.rangeLeft, [t.hiddenBehind ? `+${t.hiddenBehind}` : '', `${word} behind`].filter(Boolean).join(' · '));
    setText(els.rangeRight, [`${word} ahead`, t.hiddenAhead ? `+${t.hiddenAhead}` : ''].filter(Boolean).join(' · '));
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
        const clamped = Math.max(-t.rangeS, Math.min(t.rangeS, x.gapS));
        const left = `${(50 + clamped / t.rangeS * 50).toFixed(2)}%`;
        if (d.cache.left !== left) {
            d.cache.left = left;
            d.style.left = left;
        }
        const ox = calls?.riders?.get(x.id) ?? null;
        const call = playCall(ox, {settled: calls?.settled});
        const cls = `dot${call ? ` play-${call.play}${call.faint ? ' faint' : ''}` : ''}${named.has(x.id) ? ' named' : ''}${x.finished ? ' finished' : ''}`;
        if (d.cache.cls !== cls) {
            d.cache.cls = cls;
            d.className = cls;
        }
        const callWords = call ? playWords(ox, call) : '';
        const title = `${x.name}: ${fmtGap(x.gapS)} ${x.gapS > 0 ? 'ahead' : 'behind'} on the clock${x.finished ? `, ${finishedWords(x)}` : ''}${callWords ? `; ${callWords}` : ''}`;
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

/** A finisher's line in words: its race time, or that the time was not seen (never a made-up 0:00). */
function finishedWords(x) {
    return Number.isFinite(x.finishRaceS) ? `finished in ${fmtClock(x.finishRaceS)}` : 'finished, time not seen';
}

/** The track's range in words: '30 s', '1 min', '2 min', '5 min', or the whole field. */
function rangeWord(mode, rangeS) {
    if (mode === 'field') {
        return 'whole field';
    }
    return rangeS < 60 ? `${rangeS} s` : `${+(rangeS / 60).toFixed(1)} min`;
}

/** One side's riders, nearest first, the rate coloured only when the rider is in play. Returns their ids. */
function renderSide(ol, list, o) {
    while (ol.children.length < list.length) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="nm"></span><span class="gp"></span><span class="rt"></span>';
        const [nm, gp, rt] = li.children;
        li.cells = {nm, gp, rt};
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
        put(li, 'gp', c.gp, fmtGap(x.gapS));
        // How fast the gap moves (the last minutes); a finished rider has no more to move.
        const dr = x.finished ? null : drift(x);
        put(li, 'rt', c.rt, !dr ? (x.finished ? 'finished' : '') : dr.word === 'holding' ? 'hold' : `${dr.sPerMin > 0 ? '+' : '−'}${Math.abs(dr.sPerMin).toFixed(1)} s a minute`);
        const ox = o?.riders?.get(x.id) ?? null;
        const call = playCall(ox, {settled: o?.settled});
        const liCls = call ? `play-${call.play}${call.faint ? ' faint' : ''}` : '';
        if (li.cache.liCls !== liCls) {
            li.cache.liCls = liCls;
            li.className = liCls;
        }
        const side = x.gapS > 0 ? 'ahead' : 'behind';
        const how = x.finished
            ? `; ${finishedWords(x)}`
            : dr ? `. You ${dr.word === 'losing' ? 'lose' : dr.word === 'gaining' ? 'gain' : 'hold'} ${dr.word === 'holding' ? 'them' : `${Math.abs(dr.sPerMin).toFixed(1)} s a minute on them`} over the last ${dr.sustained ? 'four minutes' : 'minute'}` : '';
        const callWords = call ? playWords(ox, call) : '';
        const title = `${x.name}: ${fmtGap(x.gapS)} ${side} on the clock, at the same distance along the course${how}${callWords ? `. ${callWords[0].toUpperCase()}${callWords.slice(1)}` : ''}`;
        if (li.title !== title) {
            li.title = title;
        }
    });
    return list.map(x => x.id);
}

/** The middle: your place among the riders you can compare with, the verdict once settled, or your speed outside a race. */
function renderMe(o, rv, v) {
    const home = rv.home;
    const finishedPlace = home?.finished ? home.finishPlace : null;
    if (finishedPlace) {
        setText(els.meLabel, 'finished');
        setText(els.meBig, ordinal(finishedPlace));
        setText(els.meSmall, `of ${home.finishers} so far`);
        if (els.me.className !== 'me done') {
            els.me.className = 'me done';
        }
        const title = `You finished in ${Number.isFinite(home.finishRaceS) ? fmtClock(home.finishRaceS) : 'a time not seen'}`;
        if (els.me.title !== title) {
            els.me.title = title;
        }
        return;
    }
    const place = home?.comparable ? home.place : null;
    if (place != null) {
        const vt = o?.settled ? verdictText(o) : null;
        const verdict = vt && vt.kind !== 'early' ? vt : null;
        const pred = o?.settled ? o.home.predictedPlace : null;
        const heading = pred != null && pred !== place;
        setText(els.meLabel, verdict ? verdict.word : 'you');
        setText(els.meBig, ordinal(place));
        setText(els.meSmall, `of ${rv.all.length + 1}${heading ? ` → ${ordinal(pred)}` : ''}`);
        const cls = `me${verdict ? ` ${verdict.kind}` : ''}${heading ? (pred < place ? ' up' : ' down') : ''}`;
        if (els.me.className !== cls) {
            els.me.className = cls;
        }
        const title = `Your place on the clock among the riders you can compare with, at the same distance along the course${verdict ? `. ${verdict.headline}: ${verdict.detail}` : ''}`;
        if (els.me.title !== title) {
            els.me.title = title;
        }
        return;
    }
    const speedKmh = v?.live?.speedKmh ?? home?.speedKmh;
    setText(els.meLabel, 'you');
    setText(els.meBig, Number.isFinite(speedKmh) ? speedKmh.toFixed(1) : '—');
    setText(els.meSmall, 'km/h');
    if (els.me.className !== 'me') {
        els.me.className = 'me';
        els.me.title = '';
    }
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
