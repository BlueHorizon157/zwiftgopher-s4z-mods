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
import {syncOnce, chooseActivation, activePlanStep, planForPlace, fitsEvent, shouldPoll, linkStatus, choosePlanForEvent, nextTimeTrial, signedUpTimeTrials, signupRows, shelfSignups, shelfPlan, shelfPlanFromHere, PENDING_POLL_MS} from './shelf-sync.mjs';
import {hereTarget, powerHistory, chooseBike, hereOffered, bikeWords, hereCard} from './from-here.mjs';

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
    finishShows: 'remaining', // the finish cell while racing: remaining (time to go) | finish (predicted finish time)
    planItInputs: 'last',     // Plan it plans with the rider's last planner settings, or the planner's defaults
    hereBike: 'auto',         // Plan from here's bike: auto (road unless the draft says TT) | road | tt
    hereStrategy: 'balanced', // Plan from here's strategy to start on: fastest | balanced | safe_finish
    showDebug: false,
    gapMode: 'clock',         // field: clock (standings) | finish (predicted) | road (who is physically ahead)
    allSubgroups: false,      // field: riders of every category
    rivalsEach: 2,            // rivals strip: riders shown each side
    rivalsRange: 'play',      // rivals track: play (±1 min, wider for riders in play) | 30 | 60 | 120 | 300 (s each way) | field
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
    // When the library saved the active plan: the planner republishes an edited plan under
    // the same code, and this is what tells the engine it has a new file.
    const savedAtOf = code => store.getPlanEntry(code)?.loadedAt ?? null;
    let activeSavedAt = savedAtOf(activeCode);
    let cardWaiting = false;
    const engine = createEngine({plan: activePlan(), prefs: prefs(), controls: store.getControls()});
    let lastResetAt = store.getControls().resetAt;
    const eventInfoAsked = new Set();
    let tickSubgroup = null;            // the pen in the last tick, plan or not (see the tick handler)
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

    // A new plan applies at once. A strategy changes any time (Dave, 2026-11-09): racing, in
    // place, the clock and the W' carrying on. The same plan republished by the planner during
    // a race, or a strategy chosen after the finish, waits until this window's race is over.
    const beforeStart = () => engine.state.status === 'idle' || engine.state.status === 'armed';
    const syncPlan = () => {
        const code = store.getActiveCode();
        const card = store.getActiveCard();
        const savedAt = savedAtOf(code);
        const step = activePlanStep({code, card, savedAt}, {code: activeCode, card: activeCard, savedAt: activeSavedAt}, engine.state.status);
        if (step === 'same') {
            cardWaiting = false;
            return;
        }
        if (step === 'wait') {
            cardWaiting = true;
            return;
        }
        activeCode = code;
        activeCard = card;
        activeSavedAt = savedAt;
        cardWaiting = false;
        if (step === 'swap') {
            // The rider's offset and bias stay with the race.
            engine.event('strategy', {plan: activePlan(), code});
            return;
        }
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
        // A plan from here the rider has left (the race or route it was made for) is put
        // away, so the panel offers another; any window may, and the store says it once.
        if (engine.state.hereSpent && engine.state.plan?.fromHere && activeCode && store.getActiveCode() === activeCode) {
            store.setActive(null);
            note('The plan from here has ended: you left the race or route it was made for.');
        }
        // The pen the rider is in, from the tick: the engine only tracks the event while it has
        // a plan, and Plan it and the plan for the event (pickForEvent) need it before there is
        // one. What activates an arriving plan (chooseActivation) still goes by the engine's.
        // The rider's own ticks only, as the engine: spectating, the pen is someone else's.
        if (!engine.state.spectating) {
            tickSubgroup = data?.state?.eventSubgroupId ?? data?.eventSubgroupId ?? null;
            if (!tickSubgroup && !sauce.isReplay) {
                pickForRoute(data);
            }
        }
        const sg = engine.state.event.subgroupId ?? tickSubgroup;
        if (sg && (engine.state.event.kind == null || String(engine.state.event.infoFor) !== String(sg)) && !eventInfoAsked.has(String(sg))) {
            eventInfoAsked.add(String(sg));
            fetchEventInfo(sg).then(info => {
                lastEventInfo = info;
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
    let lastEventInfo = null;
    const planEntry = p => {
        const n = normalisePlan(p.raw, {code: p.code});
        return {code: p.code, routeId: p.routeId, laps: n?.laps ?? p.raw?.route?.laps ?? null, lengthM: n?.lengthM ?? null, routeName: p.routeName, event: p.event ?? p.raw?.meta?.event ?? null};
    };
    // Plans from here are the rest of one ride: never the plan for an event or the next TT.
    const eventPlans = () => store.listPlans().filter(p => !p.raw?.meta?.from_here).map(planEntry);
    const eventOf = info => ({eventId: info.eventId, subgroupId: info.subgroupId, routeId: info.routeId, laps: info.laps, distanceM: info.distanceM});
    // Where the rider is, for an arriving plan (chooseActivation): the pen (with its course
    // once the event info is in), else the route of a free ride, else nowhere.
    const placeNow = () => {
        const sg = engine.state.event.subgroupId ?? tickSubgroup;
        if (sg) {
            return {event: lastEventInfo && String(lastEventInfo.subgroupId) === String(sg) ? eventOf(lastEventInfo) : {subgroupId: sg}};
        }
        const routeId = engine.state.tick?.state?.routeId;
        return routeId ? {routeId} : null;
    };
    const pickForEvent = info => {
        if (!info?.subgroupId || pickedFor === String(info.subgroupId) || !beforeStart()) {
            return;
        }
        pickedFor = String(info.subgroupId);
        const event = eventOf(info);
        const activeCode = store.getActiveCode();
        const code = choosePlanForEvent({plans: eventPlans(), event, activeCode});
        if (code) {
            store.setActive(code);
            store.setShelf({offer: null});
            syncPlan();
            note(`Plan ${code} for ${info.name ?? 'the event'}.`);
            return;
        }
        // Nothing fits this pen: a plan for another course is put away rather than raced here
        // (Dave, 2026-11-09). Only when the event's course is known; a plan from here looks
        // after itself; the rider can load it again by hand and it stays (once per pen).
        const active = activeCode ? eventPlans().find(p => p.code === activeCode) : null;
        if (active && info.routeId != null && !fitsEvent(active, event)) {
            store.setActive(null);
            syncPlan();
            note(`Plan ${activeCode} is for another course: put away for ${info.name ?? 'this event'}. Load it from the list to ride it anyway.`);
        }
    };
    // A free ride on a route with no plan: the newest plan for that route comes up, once per
    // route, so a plan the rider puts away stays away (Dave, 2026-11-09).
    let pickedRoute = null;
    const pickForRoute = data => {
        const routeId = data?.state?.routeId;
        if (!routeId || String(routeId) === pickedRoute) {
            return;
        }
        pickedRoute = String(routeId);
        if (store.getActiveCode() || !beforeStart()) {
            return;
        }
        const code = planForPlace(eventPlans(), {routeId});
        if (code) {
            store.setActive(code);
            store.setShelf({offer: null});
            syncPlan();
            note(`Plan ${code} for this route.`);
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
        nextTT = nextTimeTrial({signedUp, plans: eventPlans(), now});
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

    // ---- Plan it (2.5): an optimised plan for the event, from the bike, no options ----
    // The target is the event the rider is in, else the next time trial; the planner builds
    // the plan with the rider's last planner settings (or its defaults) and the shelf keeps it.
    let planning = null;
    const planTarget = () => {
        const sg = engine.state.event.subgroupId ?? tickSubgroup;
        if (sg && lastEventInfo && String(lastEventInfo.subgroupId) === String(sg) && lastEventInfo.routeId != null) {
            return {routeId: String(lastEventInfo.routeId), laps: lastEventInfo.laps ?? 1, distanceM: lastEventInfo.distanceM ?? 0, eventId: lastEventInfo.eventId, subgroupId: lastEventInfo.subgroupId, ts: lastEventInfo.startMs ?? null, name: lastEventInfo.name ?? null, inEvent: true};
        }
        const next = nextTTOverride ?? nextTT;
        return next?.routeId ? {...next, inEvent: false} : null;
    };
    const planIt = async (target = null) => {
        const link = store.getLink();
        if (link?.state !== 'linked') {
            throw new Error('Link the mod to the planner first (settings → Plans → Link to the planner).');
        }
        target ??= planTarget();
        if (!target?.routeId) {
            throw new Error('Nothing to plan: join a time trial, or sign up for one.');
        }
        if (planning) {
            return null;
        }
        planning = {startedAt: Date.now(), target};
        draw();
        try {
            const inputsSource = settings?.get('planItInputs') === 'defaults' ? 'defaults' : 'last';
            let result;
            try {
                result = await shelfPlan(fetch, link.token, target, {inputsSource});
            } catch (err) {
                if (err.status === 503 && err.retryAfter) {
                    await new Promise(r => setTimeout(r, Math.min(10, err.retryAfter) * 1000));
                    result = await shelfPlan(fetch, link.token, target, {inputsSource});
                } else {
                    if (err.status === 401) {
                        store.clearLink();
                    }
                    throw err;
                }
            }
            const file = result.file;
            store.savePlan(result.code, file, {activate: beforeStart(), shelf: true, source: 'mod', event: file?.meta?.event ?? null, publishedAt: file?.meta?.published?.at ?? null, expiresAt: result.meta?.expires_at ?? null});
            if (beforeStart()) {
                store.setShelf({offer: null});
                syncPlan();
            }
            note(`Planned ${result.meta?.route_name ?? target.name ?? 'the event'}: ${result.code}${result.meta?.inputs_source === 'defaults' ? ' (the planner\'s default settings)' : ''}.`);
            refreshNextTT().catch(() => {});
            return result;
        } finally {
            planning = null;
            draw();
        }
    };

    // ---- Plan from here (README "Plan from here"): the rest of the race or route lap ----
    // With no plan for the ride, the planner plans what is left from where the rider is, with
    // the W' and the CP the ride so far has left them (the power Sauce has kept), on the bike
    // from-here.mjs chooses. The plan runs at once; the engine measures it from the moment
    // the button was pressed (the anchor), so the seconds spent planning are not lost.
    const ownEventInfo = () => {
        const sg = engine.state.tick?.state?.eventSubgroupId ?? tickSubgroup;
        return sg && lastEventInfo && String(lastEventInfo.subgroupId) === String(sg) ? lastEventInfo : null;
    };
    const fromHereTarget = () => (engine.state.spectating ? {ok: false, why: 'You are watching another rider.'} : hereTarget(engine.state.tick, ownEventInfo()));
    const planFromHere = async () => {
        const link = store.getLink();
        if (link?.state !== 'linked') {
            throw new Error('Link the mod to the planner first (settings → Plans → Link to the planner).');
        }
        const target = fromHereTarget();
        if (!target.ok) {
            throw new Error(target.why);
        }
        if (planning) {
            return null;
        }
        planning = {startedAt: Date.now(), target: {name: target.kind === 'event' ? 'the rest of the race' : 'the rest of the lap', here: true}};
        draw();
        try {
            let streams = null;
            try {
                streams = sauce.isReplay ? null : await common.rpc.getAthleteStreams('self');
            } catch (err) {
                console.warn('[from here] getAthleteStreams', err);
            }
            const history = powerHistory(streams, {eventDistanceM: target.kind === 'event' ? Number(engine.state.tick?.state?.eventDistance) : null});
            const bike = chooseBike({setting: settings?.get('hereBike'), target, draftS: history.draftS, raceS: history.raceS});
            const inputsSource = settings?.get('planItInputs') === 'defaults' ? 'defaults' : 'last';
            const req = {...target, power: history.power, raceFromS: history.raceFromS, bike: bike.bike, bikeReason: bike.reason};
            let result;
            try {
                result = await shelfPlanFromHere(fetch, link.token, req, {inputsSource});
            } catch (err) {
                if (err.status === 503 && err.retryAfter) {
                    await new Promise(r => setTimeout(r, Math.min(10, err.retryAfter) * 1000));
                    result = await shelfPlanFromHere(fetch, link.token, req, {inputsSource});
                } else {
                    if (err.status === 401) {
                        store.clearLink();
                    }
                    throw err;
                }
            }
            // The anchor goes in the file, so every window places the plan alike.
            const file = result.file;
            file.meta = {...(file.meta ?? {}), from_here: {...(file.meta?.from_here ?? {}), anchor: {
                ride_m: target.anchor.rideM, world_ms: target.anchor.worldMs, subgroup_id: target.anchor.subgroupId, route_id: target.anchor.routeId,
            }}};
            store.savePlan(result.code, file, {activate: false, shelf: true, source: 'here', event: file.meta?.event ?? null, publishedAt: file.meta?.published?.at ?? null, expiresAt: result.meta?.expires_at ?? null});
            // Balanced unless the setting says otherwise; the strategy chip changes it any time.
            store.setActive(result.code, hereCard(file, settings?.get('hereStrategy')));
            store.setShelf({offer: null});
            syncPlan();
            const fh = result.meta?.from_here ?? file.meta.from_here;
            note(`Plan from here ${result.code}: ${bikeWords(bike)}${history.power.length ? '' : ', with no power from Sauce: W\' as fresh'}${fh?.over_budget ? ', past what the planner thinks you can hold' : ''}.`);
            return result;
        } finally {
            planning = null;
            draw();
        }
    };
    /** {offered, target}: whether the panel offers Plan from here now, and what it would plan. */
    const hereOffer = (v = engine.view()) => {
        const target = fromHereTarget();
        return {
            offered: hereOffered({linked: store.getLink()?.state === 'linked', spectating: Boolean(v.spectating), status: v.status, plan: v.plan,
                mismatchM: v.event?.mismatchM ?? null, spent: Boolean(v.plan?.fromHere?.spent), target}),
            target,
        };
    };

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
                    const {activate, offer} = chooseActivation({added: r.added, plans: r.plans, entries: eventPlans(),
                        activeCode: store.getActiveCode(), where: placeNow(), beforeStart: beforeStart()});
                    // The active plan republished (edited in the planner, same code): the store
                    // tells the other windows; this one, which saved it, applies it itself.
                    const republished = store.getActiveCode();
                    if (republished && r.added.includes(republished) && !activate) {
                        syncPlan();
                        note(`Plan ${republished} updated from the planner.`);
                    }
                    if (activate) {
                        store.setActive(activate);
                        store.setShelf({offer: null});
                        syncPlan();
                        note(`Plan ${activate} from the planner, for where you are.`);
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
        /** Ride with no plan (the HUD's Clear plan): the race is cleared; a pen or route does not bring it back. */
        clearPlan() {
            const code = store.getActiveCode();
            if (!code) {
                return false;
            }
            store.setActive(null);
            syncPlan();
            note(`Plan ${code} cleared: Plan from here, Plan it or a code when you want one.`);
            draw();
            return true;
        },
        /** Ride one of the plan's strategy cards (null: the plan as shared): before the start, or racing (in place). */
        setStrategy(card) {
            if (!(beforeStart() || engine.state.status === 'racing') || !activeCode) {
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
        /** What Plan it would plan: the event the rider is in, else the next time trial; null when neither. */
        planTarget,
        /** {startedAt, target} while a plan is being built, else null. */
        planning: () => planning,
        planIt,
        /** Plan from here: the rest of the race or route lap, from where the rider is. */
        planFromHere,
        hereOffer,
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
