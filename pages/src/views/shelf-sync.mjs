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
        .map(e => ({id: e.id, name: e.name, ts: e.ts ?? null, subgroupId: (e.eventSubgroups ?? []).find(sg => sg.signedUp)?.id ?? null, routeId: e.routeId ?? null}));
}
