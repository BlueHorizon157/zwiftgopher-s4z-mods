// What every engine window does the same way (docs/REVAMP_PLAN.md 1.8, 2.2, 2.4): one
// engine on its own subscription, the plan library and controls from store.mjs, the window's
// preferences from Sauce's settingsStore, event info on a new subgroup, the shelf sync with
// the planner (TT/RIDE_DAY_PLAN.md 2.4), replay support and no work while the window is
// hidden. The window supplies render(view).
import * as common from '/pages/src/common.mjs';
import * as sauce from '../sauce.mjs';
import * as store from '../store.mjs';
import {fetchEventInfo} from '../eventinfo.mjs';
import {createEngine} from '../engine/engine.mjs';
import {normalisePlan} from '../engine/plan.mjs';
import {loadPlanByCode, fetchPlanByCode, loadReplayPlan} from './plan-loader.mjs';
import {syncOnce, chooseActivation, shouldPoll, linkStatus, choosePlanForEvent, nextTimeTrial, signedUpTimeTrials, signupRows, shelfSignups, PENDING_POLL_MS} from './shelf-sync.mjs';

export const SETTINGS_DEFAULTS = {
    layout: 'auto',           // auto = the manifest window's ?layout
    background: 'smoke',      // clear | smoke | dark | solid
    halo: 'normal',           // off | light | normal | strong
    scale: 1,                 // 0.6 – 1.6
    bandWords: true,          // "under / on / over" beside the glyph
    showLive: false,          // cadence, heart rate, speed where the layout has room (stack, a tall strip)
    smoothingSec: 3,
    bandWidthW: 5,
    soonSec: 10,              // the boundary moment starts this many seconds before a change
    startRule: 'auto',        // auto | time | distance
    showDebug: false,
    gapMode: 'clock',         // field: clock (standings) | road (who is physically ahead)
    allSubgroups: false,      // field: riders of every category
    rivalsEach: 2,            // rivals strip: riders shown each side
};

/**
 * Start a window: returns {engine, settings, view(), note(msg), messages, loadCode(text), reset()}.
 * options.render(view) is called on every tick, every settings change and once a second;
 * options.onReady(api) runs before the first render, so the window can keep the api;
 * options.onReset() runs when this or another window resets the race.
 */
const REPLAY_BACKGROUNDS = {        // ?bg= with ?replay=: stand-ins for Zwift worlds (page-check.mjs)
    snow: 'linear-gradient(180deg, #8fc3ff 0%, #dfe9f3 44%, #ffffff 46%, #e6ecf3 100%)',
    jungle: 'linear-gradient(160deg, #2f5e2a 0%, #6c9a3b 35%, #d9c37a 50%, #1e3d1c 70%, #9bb86a 100%)',
    night: 'linear-gradient(180deg, #050812 0%, #121a33 60%, #2a2f3a 100%)',
};

export function startWindow({render, onReady = null, onSettings = null, onReset = null}) {
    common.initInteractionListeners();
    const bg = new URLSearchParams(window.location.search).get('bg');
    if (sauce.isReplay && REPLAY_BACKGROUNDS[bg]) {
        document.body.style.setProperty('--replay-bg', REPLAY_BACKGROUNDS[bg]);
    }
    store.migrate();
    const settings = common.settingsStore ?? null;
    if (settings) {
        settings.setDefault({...SETTINGS_DEFAULTS});
        for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
            if (settings.get(k) === undefined) {
                settings.set(k, v);
            }
        }
    }
    const prefs = () => enginePrefs(settings ? settings.get() : {});
    // The active plan, riding the strategy card the rider chose for it (5.2).
    const activePlan = () => normalisePlan(store.getActivePlanRaw(), {code: activeCode, card: activeCard});
    let activeCode = store.getActiveCode();
    let activeCard = store.getActiveCard();
    let cardWaiting = false;
    const engine = createEngine({plan: activePlan(), prefs: prefs(), controls: store.getControls()});
    let lastResetAt = store.getControls().resetAt;
    const eventInfoAsked = new Set();
    const messages = [];
    const note = message => {
        messages.unshift({t: Date.now(), msg: message});
        messages.length = Math.min(messages.length, 50);
    };
    const draw = () => {
        if (common.isVisible()) {
            render(engine.view());
        }
    };

    // A new plan applies at once; a strategy change only before the start (decision 8): made
    // during a race (from the settings page), it waits until this window's race is over.
    const beforeStart = () => engine.state.status === 'idle' || engine.state.status === 'armed';
    const syncPlan = () => {
        const code = store.getActiveCode();
        const card = store.getActiveCard();
        if (code === activeCode && card === activeCard) {
            cardWaiting = false;
            return;
        }
        if (code === activeCode && !beforeStart()) {
            cardWaiting = true;
            return;
        }
        activeCode = code;
        activeCard = card;
        cardWaiting = false;
        engine.event('plan', {plan: activePlan(), code});
        // The engine starts a new plan with neutral controls; the store holds the rider's.
        const c = store.getControls();
        engine.control('offsetM', c.offsetM);
        engine.control('bias', c.bias);
    };

    store.onChange(key => {
        if (key === store.KEYS.active || key === store.KEYS.plans) {
            syncPlan();
        } else if (key === store.KEYS.controls) {
            const c = store.getControls();
            engine.control('offsetM', c.offsetM);
            engine.control('bias', c.bias);
            if (c.resetAt !== lastResetAt) {
                lastResetAt = c.resetAt;
                engine.event('reset');
                onReset?.();
            }
        }
        draw();
    });
    settings?.addEventListener('changed', () => {
        engine.setPrefs(prefs());
        applyLook(settings.get());
        onSettings?.(settings.get());
        draw();
    });
    document.addEventListener('visibilitychange', draw);

    if (sauce.isReplay) {
        loadReplayPlan().then(raw => {
            if (raw) {
                syncPlan();
            }
        }).catch(err => console.warn('[replay] plan', err));
        note(`Replaying ${sauce.replayName} at ${sauce.replaySpeed}x`);
    }
    sauce.subscribe('athlete/watching', data => {
        engine.tick(data, Date.now());
        if (cardWaiting && beforeStart()) {
            syncPlan();
        }
        const sg = engine.state.event.subgroupId;
        if (sg && engine.state.event.kind == null && !eventInfoAsked.has(String(sg))) {
            eventInfoAsked.add(String(sg));
            fetchEventInfo(sg).then(info => {
                engine.event('eventInfo', info);
                pickForEvent(info);
                draw();
            }).catch(() => {});
        }
        draw();
    }, {record: true});
    setInterval(draw, 1000);

    // ---- the plan for the event (TT/RIDE_DAY_PLAN.md 2.4, rules 1 and 2) ----
    // Joining a subgroup: the plan made for this pen, else for this event, else for this route
    // with the same laps or length, arms itself before the start; once per subgroup, so a
    // plan the rider then chooses by hand stays.
    let pickedFor = null;
    const planEntry = p => {
        const n = normalisePlan(p.raw, {code: p.code});
        return {code: p.code, routeId: p.routeId, laps: n?.laps ?? p.raw?.route?.laps ?? null, lengthM: n?.lengthM ?? null, routeName: p.routeName, event: p.event ?? p.raw?.meta?.event ?? null};
    };
    const pickForEvent = info => {
        if (!info?.subgroupId || pickedFor === String(info.subgroupId) || !beforeStart()) {
            return;
        }
        pickedFor = String(info.subgroupId);
        const code = choosePlanForEvent({
            plans: store.listPlans().map(planEntry),
            event: {eventId: info.eventId, subgroupId: info.subgroupId, routeId: info.routeId, laps: info.laps, distanceM: info.distanceM},
            activeCode: store.getActiveCode(),
        });
        if (code) {
            store.setActive(code);
            store.setShelf({offer: null});
            syncPlan();
            note(`Plan ${code} for ${info.name ?? 'the event'}.`);
        }
    };

    // ---- the next time trial (2.4) and the rider's sign-ups for the planner ----
    // Sauce's event cache holds about four hours ahead with the rider's sign-ups marked; the
    // shelf's event-tagged plans cover the rest. While linked, the sign-ups Sauce can see go to
    // the planner's picker once they change.
    let nextTT = null;
    let nextTTOverride = null;
    const refreshNextTT = async () => {
        if (sauce.isReplay || !beforeStart() || !common.isVisible()) {
            return;
        }
        let events = [];
        try {
            events = await common.rpc.getCachedEvents();
        } catch (err) {
            return;
        }
        const now = Date.now();
        const signedUp = signedUpTimeTrials(events ?? [], now);
        nextTT = nextTimeTrial({signedUp, plans: store.listPlans().map(planEntry), now});
        const link = store.getLink();
        if (link?.state === 'linked') {
            const rows = signupRows(signedUp);
            const key = JSON.stringify(rows.map(r => r.subgroup_id).sort());
            const shelf = store.getShelf();
            if (shelf.signupsSent !== key && now - (shelf.signupsSentAt ?? 0) > 60000) {
                store.setShelf({signupsSent: key, signupsSentAt: now});
                shelfSignups(fetch, link.token, rows).catch(() => {});
            }
        }
        draw();
    };
    setInterval(() => refreshNextTT().catch(() => {}), 60000);
    setTimeout(() => refreshNextTT().catch(() => {}), 2500);

    // ---- the shelf: plans from the planner arrive by themselves (TT/RIDE_DAY_PLAN.md 2.4) ----
    // One window polls a minute for all of them (store.getShelf().lastPollAt is the guard),
    // only while idle or armed and visible, never while racing. A pending pairing is checked
    // every few seconds, so the planner's claim is seen even with the settings page closed.
    const windowId = Math.random().toString(36).slice(2, 8);
    let linkSupported = null;
    let syncing = false;
    const pendingStatus = async () => {
        const link = store.getLink();
        if (!link || link.state !== 'pending' || sauce.isReplay) {
            return;
        }
        if (Date.now() - (link.lastStatusAt ?? 0) < PENDING_POLL_MS) {
            return;
        }
        store.setLink({...link, lastStatusAt: Date.now()});
        const st = await linkStatus(fetch, link.token);
        const current = store.getLink();
        if (!current || current.token !== link.token) {
            return;
        }
        if (st.state === 'linked') {
            const planner = (st.link?.devices ?? []).find(d => d.kind === 'planner');
            store.setLink({...current, state: 'linked', linkedAt: Date.now(), code: null, expiresAt: null,
                zwiftId: st.link?.zwift_id ?? current.zwiftId, riderName: st.link?.rider_name ?? current.riderName, plannerLabel: planner?.label ?? null});
            note('Linked to the planner.');
            draw();
            pollShelf(true);
        } else if (st.state === 'expired' || st.state === 'revoked' || st.state === 'unknown') {
            store.setLink({...current, state: st.state});
            draw();
        }
    };
    const pollShelf = async (force = false) => {
        const link = store.getLink();
        const shelf = store.getShelf();
        if (syncing || linkSupported === false || sauce.isReplay) {
            return;
        }
        if (!shouldPoll({link, quiet: beforeStart(), visible: common.isVisible(), lastPollAt: shelf.lastPollAt, now: Date.now(), force})) {
            return;
        }
        store.setShelf({lastPollAt: Date.now(), lastPollBy: windowId});
        syncing = true;
        try {
            const r = await syncOnce({
                fetchFn: fetch,
                token: link.token,
                etag: shelf.etag ?? null,
                library: {has: store.getPlanEntry, save: (code, raw, meta) => store.savePlan(code, raw, {activate: false, ...meta})},
                loadPlan: fetchPlanByCode,
            });
            if (r.status === 'revoked') {
                store.clearLink();
                note('The planner link has ended: link again from the settings page.');
            } else if (r.status === 'unsupported') {
                linkSupported = false;
                store.setShelf({unsupportedAt: Date.now()});
            } else if (r.status === 'ok') {
                linkSupported = true;
                store.setShelf({etag: r.etag, lastSyncAt: Date.now(), unsupportedAt: null});
                if (r.added.length) {
                    const {activate, offer} = chooseActivation({added: r.added, plans: r.plans, activeCode: store.getActiveCode(),
                        inEvent: Boolean(engine.state.event.subgroupId), beforeStart: beforeStart()});
                    if (activate) {
                        store.setActive(activate);
                        store.setShelf({offer: null});
                        syncPlan();
                        note(`Plan ${activate} from the planner.`);
                    } else if (offer) {
                        const e = store.getPlanEntry(offer);
                        store.setShelf({offer: {code: offer, routeName: e?.routeName ?? null, timeText: e?.timeText ?? null, at: Date.now()}});
                        note(`New plan ${offer} from the planner.`);
                    }
                }
            } else if (r.status === 'unchanged') {
                linkSupported = true;
                store.setShelf({lastSyncAt: Date.now()});
            } else if (r.error) {
                note(`Shelf: ${r.error}`);
            }
        } finally {
            syncing = false;
            draw();
        }
    };
    setInterval(() => {
        pendingStatus().catch(() => {});
        pollShelf().catch(() => {});
    }, 5000);
    window.addEventListener('focus', () => pollShelf(true).catch(() => {}));
    setTimeout(() => pollShelf(true).catch(() => {}), 1500);

    const api = {
        engine,
        settings,
        messages,
        note,
        view: () => engine.view(),
        draw,
        prefs: () => (settings ? settings.get() : {...SETTINGS_DEFAULTS}),
        async loadCode(text) {
            const {code, raw} = await loadPlanByCode(text);
            syncPlan();
            note(`Plan ${code} loaded: ${raw.route?.name ?? 'custom route'}.`);
            draw();
            return code;
        },
        /** Ride one of the plan's strategy cards (null: the plan as shared); before the start only. */
        setStrategy(card) {
            if (!beforeStart() || !activeCode) {
                return false;
            }
            store.setActiveCard(card);
            syncPlan();
            note(`Strategy: ${engine.state.plan?.strategyLabel ?? 'as shared'}.`);
            draw();
            return true;
        },
        beforeStart,
        /** A strategy change is waiting for this race to end. */
        cardWaiting: () => cardWaiting,
        reset() {
            const resetAt = Date.now();
            lastResetAt = resetAt;
            store.setControls({resetAt});
            engine.event('reset');
            onReset?.();
            note('Race statistics reset.');
            draw();
        },
        nudgeOffset(dir) {
            const offsetM = store.getControls().offsetM + dir * 10;
            store.setControls({offsetM});
            engine.control('offsetM', offsetM);
            draw();
        },
        nudgeBias(dir) {
            const bias = Math.round((store.getControls().bias + dir * 0.01) * 100) / 100;
            store.setControls({bias});
            engine.control('bias', bias);
            draw();
        },
        // The link and the shelf (TT/RIDE_DAY_PLAN.md 2.4).
        link: () => store.getLink(),
        shelf: () => store.getShelf(),
        /** A plan that arrived while another was active: offered until used or dismissed. */
        offer() {
            const o = store.getShelf().offer;
            return o && store.getPlanEntry(o.code) ? o : null;
        },
        useOffer() {
            const o = api.offer();
            if (!o || !beforeStart()) {
                return false;
            }
            store.setActive(o.code);
            store.setShelf({offer: null});
            syncPlan();
            note(`Plan ${o.code} from the planner.`);
            draw();
            return true;
        },
        dismissOffer() {
            store.setShelf({offer: null});
            draw();
        },
        syncNow: () => pollShelf(true),
        linkSupported: () => linkSupported,
        /** The next time trial the rider is signed up for or has a plan for: {id, name, ts, subgroupId, planCode}. */
        nextTT: () => nextTTOverride ?? nextTT,
        setNextTT(value) {       // scripts/page-check.mjs
            nextTTOverride = value;
            draw();
        },
    };
    window.zgtt = {engine, view: api.view, replay: sauce.replayState, settings, store, api};   // scripts/page-check.mjs and DevTools
    onReady?.(api);
    applyLook(api.prefs());
    onSettings?.(api.prefs());
    draw();
    return api;
}

/** Background, halo and size: data attributes on <html> that css/tokens.css reads. */
export function applyLook(s = {}) {
    const html = document.documentElement;
    html.dataset.bg = ['clear', 'smoke', 'dark', 'solid'].includes(s.background) ? s.background : 'smoke';
    html.dataset.halo = ['off', 'light', 'normal', 'strong'].includes(s.halo) ? s.halo : 'normal';
    const scale = Math.min(1.6, Math.max(0.6, Number(s.scale) || 1));
    html.style.setProperty('--hud-scale', String(scale));
}

export function enginePrefs(p = {}) {
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
        smoothingSec: num(p.smoothingSec ?? p.powerSmoothingSec, SETTINGS_DEFAULTS.smoothingSec),
        bandWidthW: num(p.bandWidthW ?? p.targetBandWidthW, SETTINGS_DEFAULTS.bandWidthW),
        startRule: ['auto', 'time', 'distance'].includes(p.startRule) ? p.startRule : 'auto',
    };
}

/** Plain words for the engine's status, for any window. */
export function statusWords(v) {
    switch (v.status) {
        case 'idle': return v.plan ? 'waiting for Zwift' : (store.getLink()?.state === 'linked' ? 'waiting for a plan from the planner' : 'no plan loaded');
        case 'armed': return v.event?.inEvent ? 'ready, waiting for the start' : 'ready on the route';
        case 'racing': return 'racing';
        case 'finished': return 'finished';
        default: return v.status;
    }
}
