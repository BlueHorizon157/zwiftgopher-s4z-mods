// The rider link and the shelf: pairing with the planner (link.php), reading the rider's shelf
// (shelf.php), deciding what a new plan does. Pure (network, clock, library and link state are
// arguments); views/runtime.mjs wires it to Sauce. The only credential is the device token
// that pairing returns.

export const PLANNER_BASE = 'https://zwiftgopher.com/TT';
export const POLL_MS = 60000;          // shelf poll, while idle or armed and the window is visible
export const POLL_GUARD_MS = 50000;    // another window polled this recently: skip
export const PENDING_POLL_MS = 5000;   // pairing status poll, while a code waits for the planner
export const TIMEOUT_MS = 8000;
export const PLAN_TIMEOUT_MS = 30000;  // Plan it / Plan from here: rider lookup and optimise (1-8 s)

const base = () => (typeof window !== 'undefined' && window.ZG_PLANNER_BASE) || PLANNER_BASE;

async function request(fetchFn, url, {method = 'GET', token = null, body = null, headers = {}, timeoutMs = TIMEOUT_MS} = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    // Accept: JSON keeps PHP error text out of the reply; the header is CORS-safelisted.
    const h = {Accept: 'application/json', ...headers};
    if (token) {
        h.Authorization = `Bearer ${token}`;
    }
    let data = null;
    if (body) {
        data = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
            if (v !== null && v !== undefined) {
                data.append(k, String(v));
            }
        }
        h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    try {
        const resp = await fetchFn(url, {method, headers: h, body: data ? data.toString() : undefined, signal: ctl?.signal});
        // A body that fails to arrive (abort, dropped connection) is a failed request (status 0).
        const text = await resp.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return {status: resp.status, ok: resp.ok, json, etag: resp.headers?.get?.('ETag') ?? null};
    } catch (err) {
        return {status: 0, ok: false, json: null, etag: null, error: err?.name === 'AbortError' ? 'The planner did not answer in time.' : (err?.message || String(err))};
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

const errorOf = (r, fallback) => r.json?.error || r.error || fallback;

// ---- the link (link.php) ----

/** Does the planner offer linking? An old server answers the ping with HTML or a 404. */
export async function serverSupportsLink(fetchFn) {
    const r = await request(fetchFn, `${base()}/link.php?action=ping`);
    return Boolean(r.ok && r.json?.link);
}

/** Ask for a pairing code (sends athlete id, name, label): {code, token, expiresAt, linkId, deviceId} */
export async function linkStart(fetchFn, {athleteId, name = null, label = 'Sauce4Zwift'}) {
    const r = await request(fetchFn, `${base()}/link.php`, {method: 'POST', body: {action: 'start', athlete_id: athleteId, name, label}});
    if (!r.ok || !r.json?.code) {
        throw new Error(errorOf(r, `The planner answered HTTP ${r.status}.`));
    }
    return {code: r.json.code, token: r.json.token, expiresAt: r.json.expires_at, linkId: r.json.link_id, deviceId: r.json.device_id};
}

/** {state: pending|linked|expired|revoked|unknown|offline|error, code?, expiresAt?, link?}. */
export async function linkStatus(fetchFn, token) {
    const r = await request(fetchFn, `${base()}/link.php?action=status`, {token});
    if (r.status === 0) {
        return {state: 'offline', error: r.error};
    }
    const s = r.json ?? {};
    return {state: s.state ?? (r.status === 401 ? 'unknown' : 'error'), code: s.code ?? null, expiresAt: s.expires_at ?? null, link: s.link ?? null};
}

export async function linkRevoke(fetchFn, token, deviceId = null) {
    const r = await request(fetchFn, `${base()}/link.php`, {method: 'POST', token, body: {action: 'revoke', device_id: deviceId}});
    return Boolean(r.ok && r.json?.success);
}

// ---- the shelf (shelf.php) ----

/**
 * One sync: list the shelf (304 when unchanged), fetch each plan the library lacks or that was
 * republished, and acknowledge it ('fetched').
 * library: {has(code) -> entry|null, save(code, raw, meta), prune?(codes) -> removed codes (plans
 * the shelf no longer lists), dismissed?(entry) -> true when the rider removed the plan by hand}.
 * loadPlan(code) -> {raw, meta}. canApply?() -> whether the library may change now (engine before
 * the start): checked before each change, so a sync begun before the start does nothing once the
 * race is on.
 * Returns {status: 'unchanged'|'ok'|'revoked'|'unsupported'|'error', etag, plans, added, removed,
 * link, error, incomplete}. incomplete: a plan was not fetched or applied; etag is null
 * so the next poll re-reads the listing instead of getting a 304.
 */
export async function syncOnce({fetchFn, token, etag = null, library, loadPlan, canApply = null}) {
    const r = await request(fetchFn, `${base()}/shelf.php?action=list`, {token, headers: etag ? {'If-None-Match': etag} : {}});
    if (r.status === 304) {
        return {status: 'unchanged', etag, plans: null, added: [], removed: [], link: null};
    }
    if (r.status === 401) {
        return {status: 'revoked', etag: null, plans: null, added: [], removed: [], link: null, error: errorOf(r, 'The link has ended.')};
    }
    if (r.status === 404 || (r.ok && r.json === null)) {
        return {status: 'unsupported', etag: null, plans: null, added: [], removed: [], link: null};
    }
    if (!r.ok || !Array.isArray(r.json?.plans)) {
        return {status: 'error', etag, plans: null, added: [], removed: [], link: null, error: errorOf(r, `The planner answered HTTP ${r.status}.`)};
    }
    const plans = r.json.plans;
    if (canApply && !canApply()) {
        return {status: 'ok', etag: null, plans, added: [], removed: [], link: r.json.link ?? null, incomplete: true};
    }
    // Prune first, so a replacement under a new code takes the old plan's place.
    const removed = library.prune ? library.prune(plans.map(p => p.code)) : [];
    const added = [];
    let incomplete = false;
    for (const p of plans) {
        if (library.dismissed?.(p) || !needsFetch(p, library.has(p.code))) {
            continue;
        }
        try {
            const {raw, meta} = await loadPlan(p.code);
            if (canApply && !canApply()) {
                incomplete = true;
                break;
            }
            library.save(p.code, raw, {
                expiresAt: p.expires_at ?? meta?.expires_at ?? null,
                event: p.event ?? null,
                source: p.source ?? 'planner',
                publishedAt: p.published_at ?? p.created_at ?? null,
                shelf: true,
            });
            added.push(p.code);
            await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body: {action: 'fetched', code: p.code}});
        } catch (err) {
            // Retried next poll; the etag is withheld (incomplete), or a 304 would hide the plan.
            incomplete = true;
            console.warn('[shelf] plan', p.code, err);
        }
    }
    return {status: 'ok', etag: incomplete ? null : r.etag, plans, added, removed, link: r.json.link ?? null, incomplete};
}

/** A plan the library lacks, or one republished since (fetched_at NULL again, a newer published_at). */
export function needsFetch(entry, have) {
    if (!have) {
        return true;
    }
    if (entry.fetched_at) {
        return false;
    }
    const theirs = entry.published_at ?? entry.created_at ?? null;
    return Boolean(theirs && have.publishedAt && theirs !== have.publishedAt) || Boolean(theirs && !have.publishedAt);
}

/**
 * What a window does with the active plan after a store change: 'same', 'apply' (hand it to the
 * engine), 'swap' (racing: another strategy of the same plan; targets change in place, clock and
 * W' carry on) or 'wait' (same plan republished mid-race, or a strategy chosen after the finish:
 * for the next ride). A plan is {code, card, savedAt}: an edited plan is republished under the
 * same code, so the save time tells new from old. status: the engine's.
 */
export function activePlanStep(now, had, status) {
    if (now.code === had.code && now.card === had.card && now.savedAt === had.savedAt) {
        return 'same';
    }
    if (now.code !== had.code || status === 'idle' || status === 'armed') {
        return 'apply';
    }
    return status === 'racing' && now.savedAt === had.savedAt ? 'swap' : 'wait';
}

/**
 * What a new plan does. Before the start, the newest arrival that fits where the rider is
 * (planForPlace) becomes the plan and any other is offered; while racing nothing moves.
 * entries: planEntry()s (code, routeId, laps, lengthM, event), newest first; where: {event:
 * {eventId, subgroupId, routeId, laps, distanceM}} in a pen, {routeId} on a free ride, or null.
 */
export function chooseActivation({added, plans, entries = [], activeCode, where = null, beforeStart}) {
    if (!added.length || !beforeStart) {
        return {activate: null, offer: null};
    }
    const order = (plans ?? []).map(p => p.code);
    const arrived = [...added].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const fit = planForPlace(arrived.map(code => entries.find(e => e.code === code)).filter(Boolean), where);
    if (fit && fit !== activeCode) {
        return {activate: fit, offer: null};
    }
    const newest = arrived[0];
    return {activate: null, offer: newest !== activeCode && newest !== fit ? newest : null};
}

/** The plan for where the rider is (entries newest first): the event's in a pen, else the route's. */
export function planForPlace(entries, where) {
    if (!entries?.length || !where) {
        return null;
    }
    if (where.event) {
        return choosePlanForEvent({plans: entries, event: where.event});
    }
    if (where.routeId != null) {
        return entries.find(e => e.routeId != null && String(e.routeId) === String(where.routeId))?.code ?? null;
    }
    return null;
}

export function fitsEvent(entry, event) {
    return Boolean(entry && event) && choosePlanForEvent({plans: [entry], event}) === entry.code;
}

/** Whether this window should poll the shelf now (one window a minute for all of them). */
export function shouldPoll({link, quiet, visible, lastPollAt, now, force = false}) {
    if (!link?.token || link.state !== 'linked' || !visible) {
        return false;
    }
    if (!quiet) {
        return false;
    }
    if (force) {
        return now - (lastPollAt ?? 0) > 5000;
    }
    return now - (lastPollAt ?? 0) > POLL_GUARD_MS;
}

/** The rider's signed-up time trials in Sauce's event cache, soonest first. */
export function signedUpTimeTrials(events, now) {
    return (events ?? [])
        .filter(e => (e.eventType === 'TIME_TRIAL' || (e.rulesSet ?? []).includes('NO_DRAFTING')) && (e.eventSubgroups ?? []).some(sg => sg.signedUp))
        .filter(e => !e.ts || e.ts > now - 3600000)
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .map(e => {
            const sg = (e.eventSubgroups ?? []).find(s => s.signedUp) ?? null;
            return {
                id: e.id, name: e.name, ts: e.ts ?? null, subgroupId: sg?.id ?? null,
                routeId: sg?.routeId != null ? String(sg.routeId) : (e.routeId != null ? String(e.routeId) : null),
                laps: Number(sg?.laps ?? e.laps ?? 0) || 0,
                distanceM: Math.round(Number(sg?.distanceInMeters ?? e.distanceInMeters ?? 0)) || 0,
                rules: Array.isArray(sg?.rulesSet) ? sg.rulesSet : (Array.isArray(e.rulesSet) ? e.rulesSet : []),
            };
        });
}

/**
 * The plan to arm for an event: the one made for this pen, else for this event, else for this
 * route with matching length (distance event) or laps. Null when it is already active or none fits.
 */
export function choosePlanForEvent({plans, event, activeCode = null}) {
    if (!event || !plans?.length) {
        return null;
    }
    const sg = event.subgroupId != null ? String(event.subgroupId) : null;
    const id = event.eventId != null ? String(event.eventId) : null;
    const byPen = sg ? plans.find(p => p.event?.subgroup_id != null && String(p.event.subgroup_id) === sg) : null;
    const byEvent = id ? plans.find(p => p.event?.id != null && String(p.event.id) === id) : null;
    const byRoute = event.routeId != null ? plans.find(p => String(p.routeId) === String(event.routeId) && courseMatches(p, event)) : null;
    const pick = byPen ?? byEvent ?? byRoute ?? null;
    return pick && pick.code !== activeCode ? pick.code : null;
}

/** A plan's course against an event's: within 1 % by length for a distance event, equal laps otherwise. */
export function courseMatches(plan, event) {
    const distanceM = Number(event.distanceM) || 0;
    if (distanceM > 0) {
        return Number.isFinite(plan.lengthM) && Math.abs(plan.lengthM - distanceM) <= Math.max(50, distanceM * 0.01);
    }
    const laps = Number(event.laps) || 0;
    return laps <= 0 || plan.laps == null || Number(plan.laps) === laps;
}

/** The HUD's next time trial: the soonest signed-up TT or shelf-plan event, with its fitting plan. */
export function nextTimeTrial({signedUp = [], plans = [], now}) {
    const candidates = [];
    for (const e of signedUp) {
        if (e.ts == null || e.ts > now - 3600000) {
            candidates.push({id: e.id, name: e.name, ts: e.ts, subgroupId: e.subgroupId, routeId: e.routeId, laps: e.laps ?? null, distanceM: e.distanceM ?? null, rules: e.rules ?? [], source: 'sauce'});
        }
    }
    for (const p of plans) {
        const ts = p.event?.start ? Date.parse(p.event.start) : NaN;
        if (!Number.isFinite(ts) || ts <= now - 3600000) {
            continue;
        }
        if (!candidates.some(c => String(c.id) === String(p.event.id))) {
            candidates.push({id: p.event.id, name: p.event.name ?? p.routeName ?? p.code, ts, subgroupId: p.event.subgroup_id ?? null, routeId: p.routeId, source: 'shelf'});
        }
    }
    candidates.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
    const next = candidates[0];
    if (!next) {
        return null;
    }
    const planCode = choosePlanForEvent({plans, event: {eventId: next.id, subgroupId: next.subgroupId, routeId: next.routeId, laps: next.laps, distanceM: next.distanceM}}) ?? plans.find(p => String(p.event?.id) === String(next.id))?.code ?? null;
    return {...next, planCode};
}

/** The rider's sign-ups as the shelf stores them: [{event_id, subgroup_id, start, name}]. */
export function signupRows(signedUp) {
    return (signedUp ?? [])
        .filter(e => e.subgroupId != null && e.ts != null)
        .map(e => ({event_id: e.id, subgroup_id: e.subgroupId, start: new Date(e.ts).toISOString(), name: e.name ?? null}));
}

/** Report the rider's sign-ups to the shelf (the planner's picker marks them). */
export async function shelfSignups(fetchFn, token, rows) {
    const r = await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body: {action: 'signups', subgroups: JSON.stringify(rows)}});
    return Boolean(r.ok && r.json?.success);
}

/**
 * Plan it: the planner builds an optimised plan for the linked rider and an event and shelves it:
 * {code, file, meta}. target: {routeId, laps, distanceM, eventId | id, subgroupId, ts | start,
 * name, rules}. Throws an Error with .status and .retryAfter (seconds) when the planner refuses.
 */
export async function shelfPlan(fetchFn, token, target, {inputsSource = 'last'} = {}) {
    const body = {
        action: 'plan',
        route_id: target.routeId,
        laps: target.laps ?? 1,
        distance_m: target.distanceM ?? 0,
        event_id: target.eventId ?? target.id ?? null,
        subgroup_id: target.subgroupId ?? null,
        start: target.ts ? new Date(target.ts).toISOString() : (target.start ?? null),
        name: target.name ?? null,
        rules: JSON.stringify(target.rules ?? []),
        inputs_source: inputsSource === 'defaults' ? 'defaults' : 'last',
    };
    const r = await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body, timeoutMs: PLAN_TIMEOUT_MS});
    if (r.ok && r.json?.code && r.json.file) {
        return {code: r.json.code, file: r.json.file, meta: r.json.meta ?? {}};
    }
    const err = new Error(planItErrorWords(r));
    err.status = r.status;
    err.retryAfter = Number(r.json?.retry_after) || null;
    throw err;
}

/**
 * Plan from here: the planner plans the rest of the race or route lap for the linked rider from
 * from-here.mjs's target, the ride's power (powerHistory) and the bike (chooseBike), and puts it
 * on the shelf: {code, file, meta: {from_here, ...}}. Throws as shelfPlan does.
 */
export async function shelfPlanFromHere(fetchFn, token, req, {inputsSource = 'last'} = {}) {
    const body = {
        action: 'plan_here',
        kind: req.kind === 'event' ? 'event' : 'route',
        route_id: req.routeId,
        laps: req.laps ?? 1,
        distance_m: req.distanceM ?? 0,
        remaining_m: Math.round(req.remainingM),
        event_id: req.eventId ?? null,
        subgroup_id: req.subgroupId ?? null,
        start: req.startMs ? new Date(req.startMs).toISOString() : null,
        name: req.name ?? null,
        rules: JSON.stringify(req.rules ?? []),
        inputs_source: inputsSource === 'defaults' ? 'defaults' : 'last',
        bike: req.bike === 'tt' ? 'tt' : 'road',
        bike_reason: req.bikeReason ?? null,
        power: (req.power ?? []).join(','),
        race_from_s: req.raceFromS ?? 0,
    };
    const r = await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body, timeoutMs: PLAN_TIMEOUT_MS});
    if (r.ok && r.json?.code && r.json.file) {
        return {code: r.json.code, file: r.json.file, meta: r.json.meta ?? {}};
    }
    const err = new Error(planItErrorWords(r));
    err.status = r.status;
    err.retryAfter = Number(r.json?.retry_after) || null;
    throw err;
}

export function planItErrorWords(r) {
    if (r.status === 0) {
        return r.error || 'The planner did not answer.';
    }
    if (r.status === 401) {
        return 'The link has ended: link the mod to the planner again (settings → Plans).';
    }
    if (r.json?.error) {
        return r.json.error;
    }
    return r.status === 503 ? 'The planner is busy: try again in a moment.' : `The planner answered HTTP ${r.status}.`;
}
