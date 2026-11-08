// The rider link and the shelf, as the mod sees them (TT/RIDE_DAY_PLAN.md 2.1, 2.4): pairing
// with the planner (link.php), reading the rider's shelf (shelf.php) and deciding what a new
// plan does. Pure: the network, the clock, the library and the link state all come in as
// arguments, so the rules run in Node (test/shelf-sync.test.mjs); views/runtime.mjs wires
// them to Sauce. No API keys anywhere: the token is made by pairing and never shown.

export const PLANNER_BASE = 'https://zwiftgopher.com/TT';
export const POLL_MS = 60000;          // the shelf, while idle or armed and the window is visible
export const POLL_GUARD_MS = 50000;    // another window polled this recently: let it be
export const PENDING_POLL_MS = 5000;   // the pairing status, while a code waits for the planner
export const TIMEOUT_MS = 8000;

const base = () => (typeof window !== 'undefined' && window.ZG_PLANNER_BASE) || PLANNER_BASE;

async function request(fetchFn, url, {method = 'GET', token = null, body = null, headers = {}} = {}) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    const h = {...headers};
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
        const text = await resp.text().catch(() => '');
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

/** Ask for a pairing code: {code, token, expiresAt, linkId, deviceId}. */
export async function linkStart(fetchFn, {athleteId, name = null, label = 'Sauce4Zwift'}) {
    const r = await request(fetchFn, `${base()}/link.php`, {method: 'POST', body: {action: 'start', athlete_id: athleteId, name, label}});
    if (!r.ok || !r.json?.code) {
        throw new Error(errorOf(r, `The planner answered HTTP ${r.status}.`));
    }
    return {code: r.json.code, token: r.json.token, expiresAt: r.json.expires_at, linkId: r.json.link_id, deviceId: r.json.device_id};
}

/** {state: pending|linked|expired|revoked|unknown, code?, expiresAt?, link?}. */
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
 * One sync: the listing (304 when nothing changed), the plans the library lacks or that were
 * republished, each fetched by its code and acknowledged.
 *
 * library: {has(code) -> entry|null, save(code, raw, meta)}; loadPlan(code) -> {raw, meta}.
 * Returns {status: 'unchanged'|'ok'|'revoked'|'unsupported'|'error'|'unpaired', etag, plans, added, link, error}.
 */
export async function syncOnce({fetchFn, token, etag = null, library, loadPlan}) {
    const r = await request(fetchFn, `${base()}/shelf.php?action=list`, {token, headers: etag ? {'If-None-Match': etag} : {}});
    if (r.status === 304) {
        return {status: 'unchanged', etag, plans: null, added: [], link: null};
    }
    if (r.status === 401) {
        return {status: 'revoked', etag: null, plans: null, added: [], link: null, error: errorOf(r, 'The link has ended.')};
    }
    if (r.status === 404 || (r.ok && r.json === null)) {
        return {status: 'unsupported', etag: null, plans: null, added: [], link: null};
    }
    if (!r.ok || !Array.isArray(r.json?.plans)) {
        return {status: 'error', etag, plans: null, added: [], link: null, error: errorOf(r, `The planner answered HTTP ${r.status}.`)};
    }
    const plans = r.json.plans;
    const added = [];
    for (const p of plans) {
        if (!needsFetch(p, library.has(p.code))) {
            continue;
        }
        try {
            const {raw, meta} = await loadPlan(p.code);
            library.save(p.code, raw, {
                expiresAt: meta?.expires_at ?? p.expires_at ?? null,
                event: p.event ?? null,
                source: p.source ?? 'planner',
                publishedAt: p.published_at ?? p.created_at ?? null,
                shelf: true,
            });
            added.push(p.code);
            await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body: {action: 'fetched', code: p.code}});
        } catch (err) {
            // Next poll tries again; the listing still counts as read.
            console.warn('[shelf] plan', p.code, err);
        }
    }
    return {status: 'ok', etag: r.etag, plans, added, link: r.json.link ?? null};
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
 * What a new plan does (decision 3): with nothing active and the rider outside an event, the
 * newest arrival becomes the plan; with a plan active and the start not yet made, it is
 * offered; while racing nothing moves (the caller does not sync then anyway).
 */
export function chooseActivation({added, plans, activeCode, inEvent, beforeStart}) {
    if (!added.length) {
        return {activate: null, offer: null};
    }
    const order = (plans ?? []).map(p => p.code);
    const newest = [...added].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? added[0];
    if (!activeCode && !inEvent) {
        return {activate: newest, offer: null};
    }
    if (beforeStart && newest !== activeCode) {
        return {activate: null, offer: newest};
    }
    return {activate: null, offer: null};
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

/** The rider's signed-up time trials in Sauce's event cache (Phase 2 reads them; here for the toast). */
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

// ---- events (TT/RIDE_DAY_PLAN.md 2.4) ----

/**
 * The plan to arm for the event the rider is in (decision 3, rules 1 and 2): the plan made for
 * this pen, else for this event, else the plan for this route whose length (a distance event)
 * or laps (a laps event) match. Entries: {code, routeId, laps, lengthM, event}. Null when the
 * active plan already is the match, or nothing matches.
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

/**
 * The next time trial for the HUD: the soonest signed-up TT Sauce knows (signedUpTimeTrials)
 * or the soonest event a shelf plan was made for, with the plan that fits it, if any.
 */
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

// ---- Plan it (TT/RIDE_DAY_PLAN.md 2.5) ----

/**
 * An optimised plan for an event, built by the planner for the linked rider and put on the
 * shelf: {code, file, meta: {inputs_source, route_name, time_text, ...}}. target: {routeId,
 * laps, distanceM, eventId | id, subgroupId, ts | start, name, rules}. Throws an Error with
 * .status and .retryAfter (seconds) when the planner says no.
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
    const r = await request(fetchFn, `${base()}/shelf.php`, {method: 'POST', token, body});
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
