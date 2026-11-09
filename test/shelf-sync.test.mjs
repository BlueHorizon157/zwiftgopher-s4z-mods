import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncOnce, needsFetch, chooseActivation, activePlanStep, planForPlace, fitsEvent, shouldPoll, linkStart, linkStatus, serverSupportsLink, signedUpTimeTrials, POLL_GUARD_MS} from '../pages/src/views/shelf-sync.mjs';

// A fetch that answers from a script: [{match: url substring, status, json, etag}].
function fakeFetch(script) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null});
        const hit = script.find(s => String(url).includes(s.match) && (!s.method || s.method === (init.method ?? 'GET')));
        if (!hit) {
            return {status: 404, ok: false, text: async () => 'not found', headers: {get: () => null}};
        }
        const body = hit.text ?? (hit.json !== undefined ? JSON.stringify(hit.json) : '');
        return {status: hit.status, ok: hit.status >= 200 && hit.status < 300, text: async () => body, headers: {get: name => (name === 'ETag' ? hit.etag ?? null : null)}};
    };
    fn.calls = calls;
    return fn;
}

function library(entries = {}) {
    const map = new Map(Object.entries(entries));
    return {
        has: code => map.get(code) ?? null,
        save: (code, raw, meta) => map.set(code, {raw, ...meta}),
        map,
    };
}

const listing = (plans, link = {zwift_id: 354912, rider_name: 'Dave', devices: []}) => ({success: true, plans, link});
const plan = (code, extra = {}) => ({code, route_id: '3395698268', route_name: 'Flat Out Fast', laps: 1, time_text: '14:57', strategy: 'fastest', source: 'planner', event: null, created_at: '2026-11-08 10:00:00', published_at: '2026-11-08T10:00:00+00:00', expires_at: '2026-11-15 10:00:00', fetched_at: null, ...extra});

test('a sync fetches the plans the library lacks and acknowledges each', async () => {
    const fetchFn = fakeFetch([
        {match: 'shelf.php?action=list', status: 200, json: listing([plan('AAAAAA'), plan('BBBBBB', {fetched_at: '2026-11-08 10:05:00'})]), etag: 'W/"abc"'},
        {match: 'shelf.php', method: 'POST', status: 200, json: {success: true, fetched: true}},
    ]);
    const lib = library();
    const loaded = [];
    const r = await syncOnce({fetchFn, token: 'zgt_x', library: lib, loadPlan: async code => { loaded.push(code); return {raw: {schema: 'zg-tt-plan/1', code}, meta: {expires_at: '2026-11-15 10:00:00'}}; }});
    assert.equal(r.status, 'ok');
    assert.equal(r.etag, 'W/"abc"');
    assert.deepEqual(r.added, ['AAAAAA', 'BBBBBB'], 'both are new to the library');
    assert.deepEqual(loaded, ['AAAAAA', 'BBBBBB']);
    assert.equal(lib.map.get('AAAAAA').publishedAt, '2026-11-08T10:00:00+00:00');
    assert.equal(lib.map.get('AAAAAA').source, 'planner');
    assert.equal(lib.map.get('AAAAAA').shelf, true);
    const acks = fetchFn.calls.filter(c => c.method === 'POST');
    assert.equal(acks.length, 2);
    assert.match(acks[0].body, /action=fetched&code=AAAAAA/);
    assert.equal(fetchFn.calls[0].headers.Authorization, 'Bearer zgt_x', 'the token goes as a bearer');
    assert.equal(r.link.rider_name, 'Dave');
});

test('a listing that has not changed is a 304 and costs nothing else', async () => {
    const fetchFn = fakeFetch([{match: 'shelf.php?action=list', status: 304}]);
    const r = await syncOnce({fetchFn, token: 'zgt_x', etag: 'W/"abc"', library: library(), loadPlan: async () => { throw new Error('must not load'); }});
    assert.equal(r.status, 'unchanged');
    assert.equal(r.etag, 'W/"abc"');
    assert.equal(fetchFn.calls[0].headers['If-None-Match'], 'W/"abc"');
    assert.equal(fetchFn.calls.length, 1);
});

test('a 401 means the link has ended; a 404 means the planner has no shelf', async () => {
    const gone = await syncOnce({fetchFn: fakeFetch([{match: 'shelf.php?action=list', status: 401, json: {success: false, error: 'This link is not valid any more.'}}]), token: 'zgt_x', library: library(), loadPlan: async () => ({})});
    assert.equal(gone.status, 'revoked');
    assert.match(gone.error, /not valid/);
    const old = await syncOnce({fetchFn: fakeFetch([]), token: 'zgt_x', library: library(), loadPlan: async () => ({})});
    assert.equal(old.status, 'unsupported');
    const html = await syncOnce({fetchFn: fakeFetch([{match: 'shelf.php?action=list', status: 200, text: '<html>old server</html>'}]), token: 'zgt_x', library: library(), loadPlan: async () => ({})});
    assert.equal(html.status, 'unsupported');
});

test('a plan the library has is left alone unless it was republished', () => {
    const have = {publishedAt: '2026-11-08T10:00:00+00:00'};
    assert.equal(needsFetch(plan('A', {fetched_at: '2026-11-08 10:01:00'}), have), false, 'fetched already');
    assert.equal(needsFetch(plan('A'), have), false, 'same publication, not yet acknowledged');
    assert.equal(needsFetch(plan('A', {published_at: '2026-11-08T11:00:00+00:00'}), have), true, 'republished (an edit kept)');
    assert.equal(needsFetch(plan('A'), null), true, 'not in the library');
    assert.equal(needsFetch(plan('A'), {publishedAt: null}), true, 'kept before publications were recorded');
});

test('a failed plan download leaves the plan for the next poll and the listing read', async () => {
    const fetchFn = fakeFetch([
        {match: 'shelf.php?action=list', status: 200, json: listing([plan('AAAAAA'), plan('BBBBBB')]), etag: 'W/"e"'},
        {match: 'shelf.php', method: 'POST', status: 200, json: {success: true}},
    ]);
    const lib = library();
    const r = await syncOnce({fetchFn, token: 'zgt_x', library: lib, loadPlan: async code => { if (code === 'AAAAAA') { throw new Error('timeout'); } return {raw: {code}, meta: {}}; }});
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.added, ['BBBBBB']);
    assert.equal(lib.map.has('AAAAAA'), false);
    assert.equal(fetchFn.calls.filter(c => c.method === 'POST').length, 1, 'only the saved plan is acknowledged');
});

test('an arriving plan comes up only where it fits (its pen, its event, the route being ridden); otherwise it is offered', () => {
    const plans = [plan('NEW111'), plan('OLD111')];
    const entry = (code, extra = {}) => ({code, routeId: '3395698268', laps: 1, lengthM: 10710, event: null, ...extra});
    const entries = [entry('NEW111'), entry('OLD111')];
    const flatOutFast = {routeId: '3395698268'};
    const elsewhere = {routeId: '1111111111'};
    assert.deepEqual(chooseActivation({added: ['OLD111', 'NEW111'], plans, entries, activeCode: null, where: flatOutFast, beforeStart: true}), {activate: 'NEW111', offer: null}, 'riding its route: the newest of the arrivals, in the shelf\'s order');
    assert.deepEqual(chooseActivation({added: ['NEW111'], plans, entries, activeCode: null, where: elsewhere, beforeStart: true}), {activate: null, offer: 'NEW111'}, 'warming up on another route: offered, not loaded');
    assert.deepEqual(chooseActivation({added: ['NEW111'], plans, entries, activeCode: null, where: null, beforeStart: true}), {activate: null, offer: 'NEW111'}, 'nowhere yet (no route): offered');
    assert.deepEqual(chooseActivation({added: ['NEW111'], plans, entries, activeCode: 'OLD111', where: flatOutFast, beforeStart: true}), {activate: 'NEW111', offer: null}, 'a newer plan for this route replaces the one loaded');
    const penPlans = [entry('PEN111', {event: {id: 5727315, subgroup_id: 7380880}}), entry('NEW111')];
    const pen = {event: {eventId: 5727315, subgroupId: 7380880, routeId: '3395698268', laps: 1}};
    assert.deepEqual(chooseActivation({added: ['PEN111'], plans: [plan('PEN111')], entries: penPlans, activeCode: null, where: pen, beforeStart: true}), {activate: 'PEN111', offer: null}, 'in its pen');
    assert.deepEqual(chooseActivation({added: ['PEN111'], plans: [plan('PEN111')], entries: penPlans, activeCode: null, where: {event: {subgroupId: 7380880}}, beforeStart: true}), {activate: 'PEN111', offer: null}, 'in its pen before the event info is in');
    assert.deepEqual(chooseActivation({added: ['PEN111'], plans: [plan('PEN111')], entries: penPlans, activeCode: null, where: {event: {eventId: 1, subgroupId: 2, routeId: '1111111111', laps: 1}}, beforeStart: true}), {activate: null, offer: 'PEN111'}, 'in another pen: offered');
    assert.deepEqual(chooseActivation({added: ['NEW111'], plans, entries, activeCode: 'OLD111', where: flatOutFast, beforeStart: false}), {activate: null, offer: null}, 'racing: nothing');
    assert.deepEqual(chooseActivation({added: ['OLD111'], plans, entries, activeCode: 'OLD111', where: flatOutFast, beforeStart: true}), {activate: null, offer: null}, 'the active plan republished is no offer');
    assert.deepEqual(chooseActivation({added: [], plans, entries, activeCode: null, where: flatOutFast, beforeStart: true}), {activate: null, offer: null});
});

test('a plan fits a pen by pen, event, or route with the same laps or length; a free ride by route', () => {
    const e = (code, extra = {}) => ({code, routeId: '3395698268', laps: 1, lengthM: 10710, event: null, ...extra});
    const event = {eventId: 9, subgroupId: 90, routeId: '3395698268', laps: 1};
    assert.equal(fitsEvent(e('A'), event), true, 'same route and laps');
    assert.equal(fitsEvent(e('A', {laps: 2}), event), false, 'other laps');
    assert.equal(fitsEvent(e('A', {routeId: '1'}), event), false, 'other route');
    assert.equal(fitsEvent(e('A', {routeId: '1', event: {id: 9}}), event), true, 'made for the event');
    assert.equal(planForPlace([e('NEWER'), e('OLDER')], {routeId: '3395698268'}), 'NEWER', 'free ride: the newest for the route');
    assert.equal(planForPlace([e('A')], {routeId: '1'}), null);
    assert.equal(planForPlace([e('A')], null), null);
});

test('the active plan republished reaches the engine before the start; a strategy changes any time', () => {
    const had = {code: 'OLD111', card: null, savedAt: 1000};
    assert.equal(activePlanStep({...had}, had, 'armed'), 'same', 'nothing changed');
    assert.equal(activePlanStep({...had, savedAt: 2000}, had, 'armed'), 'apply', 'edited in the planner, same code: the new file before the start');
    assert.equal(activePlanStep({...had, savedAt: 2000}, had, 'racing'), 'wait', 'racing: the edit waits for the race to end');
    assert.equal(activePlanStep({...had, card: 'balanced'}, had, 'idle'), 'apply', 'a strategy change before the start');
    assert.equal(activePlanStep({...had, card: 'balanced'}, had, 'racing'), 'swap', 'a strategy change while racing: in place');
    assert.equal(activePlanStep({...had, card: 'balanced', savedAt: 2000}, had, 'racing'), 'wait', 'a new file and a strategy while racing: after the race');
    assert.equal(activePlanStep({...had, card: 'balanced'}, had, 'finished'), 'wait', 'after the finish: for the next ride');
    assert.equal(activePlanStep({code: 'NEW111', card: null, savedAt: 3000}, had, 'racing'), 'apply', 'another plan applies at once, racing or not');
    assert.equal(activePlanStep({code: null, card: null, savedAt: null}, had, 'armed'), 'apply', 'the plan cleared');
});

test('one window polls a minute, only while linked, quiet and visible', () => {
    const link = {token: 'zgt_x', state: 'linked'};
    const now = 1_000_000;
    assert.equal(shouldPoll({link, quiet: true, visible: true, lastPollAt: now - POLL_GUARD_MS - 1, now}), true);
    assert.equal(shouldPoll({link, quiet: true, visible: true, lastPollAt: now - 10000, now}), false, 'another window polled 10 s ago');
    assert.equal(shouldPoll({link, quiet: true, visible: true, lastPollAt: now - 10000, now, force: true}), true, 'a focus forces it, 5 s apart at most');
    assert.equal(shouldPoll({link, quiet: true, visible: true, lastPollAt: now - 2000, now, force: true}), false);
    assert.equal(shouldPoll({link, quiet: false, visible: true, lastPollAt: 0, now}), false, 'never while racing');
    assert.equal(shouldPoll({link, quiet: true, visible: false, lastPollAt: 0, now}), false, 'not while hidden');
    assert.equal(shouldPoll({link: {token: 'zgt_x', state: 'pending'}, quiet: true, visible: true, lastPollAt: 0, now}), false, 'not before the planner has claimed the code');
    assert.equal(shouldPoll({link: null, quiet: true, visible: true, lastPollAt: 0, now}), false);
});

test('pairing: start gives a code and a token; status reads the state; the ping detects an old server', async () => {
    const fetchFn = fakeFetch([
        {match: 'link.php?action=ping', status: 200, json: {success: true, link: 1}},
        {match: 'link.php?action=status', status: 200, json: {success: true, state: 'pending', code: 'ABC234', expires_at: '2026-11-08 10:10:00'}},
        {match: 'link.php', method: 'POST', status: 200, json: {success: true, code: 'ABC234', token: 'zgt_t', expires_at: '2026-11-08 10:10:00', link_id: 7, device_id: 9}},
    ]);
    assert.equal(await serverSupportsLink(fetchFn), true);
    const s = await linkStart(fetchFn, {athleteId: 354912, name: 'Dave'});
    assert.deepEqual(s, {code: 'ABC234', token: 'zgt_t', expiresAt: '2026-11-08 10:10:00', linkId: 7, deviceId: 9});
    assert.match(fetchFn.calls.at(-1).body, /action=start&athlete_id=354912&name=Dave&label=Sauce4Zwift/);
    const st = await linkStatus(fetchFn, 'zgt_t');
    assert.equal(st.state, 'pending');
    assert.equal(st.code, 'ABC234');
    assert.equal(await serverSupportsLink(fakeFetch([{match: 'link.php?action=ping', status: 200, text: '<html>'}])), false, 'an old server answers HTML');
    assert.equal(await serverSupportsLink(fakeFetch([])), false, 'or a 404');
    const refused = fakeFetch([{match: 'link.php', method: 'POST', status: 429, json: {success: false, error: 'Too many link requests'}}]);
    await assert.rejects(() => linkStart(refused, {athleteId: 1}), /Too many link requests/);
});

test('the signed-up time trials in the event cache, soonest first', () => {
    const now = 1_700_000_000_000;
    const events = [
        {id: 1, name: 'Later TT', eventType: 'TIME_TRIAL', ts: now + 7200000, routeId: 5, eventSubgroups: [{id: 11, signedUp: false}, {id: 12, signedUp: true}]},
        {id: 2, name: 'Sooner TT', eventType: 'TIME_TRIAL', ts: now + 3600000, routeId: 6, eventSubgroups: [{id: 21, signedUp: true}]},
        {id: 3, name: 'Not signed up', eventType: 'TIME_TRIAL', ts: now + 1800000, eventSubgroups: [{id: 31, signedUp: false}]},
        {id: 4, name: 'Group ride', eventType: 'GROUP_RIDE', ts: now + 1800000, eventSubgroups: [{id: 41, signedUp: true}]},
        {id: 5, name: 'No-draft ride', eventType: 'GROUP_RIDE', rulesSet: ['NO_DRAFTING'], ts: now + 5400000, eventSubgroups: [{id: 51, signedUp: true}]},
        {id: 6, name: 'Yesterday', eventType: 'TIME_TRIAL', ts: now - 86400000, eventSubgroups: [{id: 61, signedUp: true}]},
    ];
    assert.deepEqual(signedUpTimeTrials(events, now).map(e => [e.id, e.subgroupId]), [[2, 21], [5, 51], [1, 12]]);
    const withCourse = signedUpTimeTrials([{id: 7, name: 'Cleveland', eventType: 'TIME_TRIAL', ts: now + 3600000, routeId: 2128890027, laps: 0, distanceInMeters: 16093, eventSubgroups: [{id: 71, signedUp: true, routeId: 4131664304, laps: 0, distanceInMeters: 40234, rulesSet: ['NO_DRAFTING']}]}], now)[0];
    assert.deepEqual([withCourse.routeId, withCourse.laps, withCourse.distanceM, withCourse.rules], ['4131664304', 0, 40234, ['NO_DRAFTING']], 'the signed-up pen\'s course, for Plan it');
});

test('Plan it asks the shelf for a plan and brings the file back; refusals come as words', async () => {
    const file = {schema: 'zg-tt-plan/1', intervals: [{power_w: 300}], meta: {event: {id: 5727315}}};
    const fetchFn = fakeFetch([{match: 'shelf.php', method: 'POST', status: 200, json: {success: true, code: 'PLAN11', file, meta: {inputs_source: 'defaults', route_name: 'Urumaze', time_text: '14:57'}}}]);
    const r = await shelfPlan(fetchFn, 'zgt_x', {routeId: '4092230492', laps: 1, eventId: 5727315, subgroupId: 7380880, ts: Date.parse('2026-11-20T00:20:00Z'), name: 'Urumaze', rules: ['NO_DRAFTING']}, {inputsSource: 'last'});
    assert.equal(r.code, 'PLAN11');
    assert.equal(r.file.meta.event.id, 5727315);
    assert.equal(r.meta.inputs_source, 'defaults');
    const body = fetchFn.calls[0].body;
    assert.match(body, /action=plan&route_id=4092230492&laps=1&distance_m=0&event_id=5727315&subgroup_id=7380880&start=2026-11-20T00%3A20%3A00\.000Z&name=Urumaze&rules=%5B%22NO_DRAFTING%22%5D&inputs_source=last/);
    assert.equal(fetchFn.calls[0].headers.Authorization, 'Bearer zgt_x');
    const busy = fakeFetch([{match: 'shelf.php', method: 'POST', status: 503, json: {success: false, error: 'The planner is busy: try again in 5 s.', retry_after: 5}}]);
    await assert.rejects(() => shelfPlan(busy, 'zgt_x', {routeId: '1'}), err => err.status === 503 && err.retryAfter === 5 && /busy/.test(err.message));
    const spent = fakeFetch([{match: 'shelf.php', method: 'POST', status: 429, json: {success: false, error: 'Plan it has made its plans for now (six an hour): try again in 40 min, or plan in the planner.', retry_after: 2400}}]);
    await assert.rejects(() => shelfPlan(spent, 'zgt_x', {routeId: '1'}), /six an hour/);
    const gone = fakeFetch([{match: 'shelf.php', method: 'POST', status: 401, json: {success: false, error: 'This link is not valid any more.'}}]);
    await assert.rejects(() => shelfPlan(gone, 'zgt_x', {routeId: '1'}), /link has ended/);
    assert.match(planItErrorWords({status: 0, error: 'The planner did not answer in time.'}), /did not answer/);
    assert.match(planItErrorWords({status: 500, json: null}), /HTTP 500/);
});

import {choosePlanForEvent, courseMatches, nextTimeTrial, signupRows, shelfSignups, shelfPlan, planItErrorWords} from '../pages/src/views/shelf-sync.mjs';

const entry = (code, extra = {}) => ({code, routeId: '4092230492', laps: 1, lengthM: 10710, routeName: 'Urumaze', event: null, ...extra});

test('the plan for the event: by pen, then by event, then by route and course', () => {
    const plans = [
        entry('PEN111', {event: {id: 5727315, subgroup_id: 7380880, name: 'Urumaze A', start: '2026-11-08T00:20:00Z'}}),
        entry('EVT111', {event: {id: 5727315, subgroup_id: 7380882, name: 'Urumaze C', start: '2026-11-08T00:20:00Z'}}),
        entry('RTE111'),
        entry('RTE222', {laps: 2, lengthM: 21000}),
        entry('OTHER1', {routeId: '1', event: {id: 99, subgroup_id: 9, start: '2026-11-09T00:00:00Z'}}),
    ];
    assert.equal(choosePlanForEvent({plans, event: {eventId: 5727315, subgroupId: 7380880, routeId: '4092230492', laps: 1}}), 'PEN111', 'the pen first');
    assert.equal(choosePlanForEvent({plans, event: {eventId: 5727315, subgroupId: 7380881, routeId: '4092230492', laps: 1}}), 'PEN111', 'another pen of the event: the first plan for the event');
    assert.equal(choosePlanForEvent({plans: plans.slice(1), event: {eventId: 5727315, subgroupId: 7380881, routeId: '4092230492', laps: 1}}), 'EVT111');
    assert.equal(choosePlanForEvent({plans: plans.slice(2), event: {eventId: 1, subgroupId: 2, routeId: '4092230492', laps: 1}}), 'RTE111', 'no plan for the event: the route with the same laps');
    assert.equal(choosePlanForEvent({plans: plans.slice(2), event: {eventId: 1, subgroupId: 2, routeId: '4092230492', laps: 2}}), 'RTE222', 'two laps: the two-lap plan');
    assert.equal(choosePlanForEvent({plans: plans.slice(2), event: {eventId: 1, subgroupId: 2, routeId: '4092230492', laps: 3}}), null, 'three laps: nothing fits');
    assert.equal(choosePlanForEvent({plans: plans.slice(2), event: {eventId: 1, subgroupId: 2, routeId: '4092230492', distanceM: 21100}}), 'RTE222', 'a distance event: the plan within 1 % of the length');
    assert.equal(choosePlanForEvent({plans, event: {eventId: 5727315, subgroupId: 7380880, routeId: '4092230492'}, activeCode: 'PEN111'}), null, 'the active plan is already the match');
    assert.equal(choosePlanForEvent({plans, event: null}), null);
    assert.equal(courseMatches({lengthM: 16093, laps: 0}, {distanceM: 16093}), true);
    assert.equal(courseMatches({lengthM: 16093}, {distanceM: 40234}), false);
    assert.equal(courseMatches({laps: null}, {laps: 2}), true, 'a plan without laps recorded is not held against the event');
});

test('the next time trial: the soonest signed-up event or shelf event, with its plan', () => {
    const now = Date.parse('2026-11-08T10:00:00Z');
    const plans = [
        entry('PLAN11', {event: {id: 5727386, subgroup_id: 7380999, name: 'Zwift TT Club Racing - Urumaze', start: '2026-11-08T12:20:00Z'}}),
        entry('PLAN22', {routeId: '2128890027', event: {id: 5800001, subgroup_id: 1, name: 'Tempus Fugit TT', start: '2026-11-11T19:20:00Z'}}),
    ];
    const signedUp = [{id: 5765491, name: 'Torturefest Alpe', ts: Date.parse('2026-11-08T11:15:00Z'), subgroupId: 55, routeId: '2663908549'}];
    const next = nextTimeTrial({signedUp, plans, now});
    assert.equal(next.id, 5765491, 'the signed-up Alpe comes first');
    assert.equal(next.planCode, null, 'no plan for it');
    const later = nextTimeTrial({signedUp: [], plans, now});
    assert.equal(later.id, 5727386);
    assert.equal(later.planCode, 'PLAN11', 'the shelf plan made for it');
    assert.equal(later.source, 'shelf');
    assert.equal(nextTimeTrial({signedUp: [], plans: [], now}), null);
    assert.equal(nextTimeTrial({signedUp: [], plans, now: Date.parse('2026-11-08T14:00:00Z')}).id, 5800001, 'an event over an hour past is gone');
    const both = nextTimeTrial({signedUp: [{id: 5727386, name: 'Urumaze', ts: Date.parse('2026-11-08T12:20:00Z'), subgroupId: 7380999, routeId: '4092230492'}], plans, now});
    assert.equal(both.planCode, 'PLAN11', 'a signed-up event with a plan for its pen');
    assert.equal(both.source, 'sauce');
});

test('sign-ups go to the shelf as rows with event, pen, start and name', async () => {
    const rows = signupRows([{id: 1, name: 'A', ts: Date.parse('2026-11-08T12:20:00Z'), subgroupId: 11}, {id: 2, name: 'no pen', ts: 5, subgroupId: null}]);
    assert.deepEqual(rows, [{event_id: 1, subgroup_id: 11, start: '2026-11-08T12:20:00.000Z', name: 'A'}]);
    const fetchFn = fakeFetch([{match: 'shelf.php', method: 'POST', status: 200, json: {success: true, count: 1}}]);
    assert.equal(await shelfSignups(fetchFn, 'zgt_x', rows), true);
    assert.match(fetchFn.calls[0].body, /action=signups&subgroups=%5B%7B%22event_id%22%3A1/);
    assert.equal(fetchFn.calls[0].headers.Authorization, 'Bearer zgt_x');
});

import {shelfPlanFromHere} from '../pages/src/views/shelf-sync.mjs';

test('Plan from here sends the rest of the ride and the power so far; the file comes back', async () => {
    const file = {schema: 'zg-tt-plan/1', intervals: [{power_w: 280}], meta: {from_here: {kind: 'event', start_wbal_fraction: 0.6}}};
    const fetchFn = fakeFetch([{match: 'shelf.php', method: 'POST', status: 200, json: {success: true, code: 'HERE11', file, meta: {from_here: {cp_factor: 0.97}, route_name: 'Watopia Flat · from here'}}}]);
    const r = await shelfPlanFromHere(fetchFn, 'zgt_x', {kind: 'event', routeId: '3395698268', laps: 2, distanceM: null, remainingM: 8200.4, eventId: '55', subgroupId: '777', startMs: Date.parse('2026-11-20T00:20:00Z'), name: 'Crit', rules: ['NO_POWERUPS'], bike: 'road', bikeReason: 'drafted', power: [200, 210, -1, 250], raceFromS: 1}, {inputsSource: 'defaults'});
    assert.equal(r.code, 'HERE11');
    assert.equal(r.file.meta.from_here.start_wbal_fraction, 0.6);
    const body = fetchFn.calls[0].body;
    assert.match(body, /^action=plan_here&kind=event&route_id=3395698268&laps=2&distance_m=0&remaining_m=8200&event_id=55&subgroup_id=777&start=2026-11-20T00%3A20%3A00\.000Z&name=Crit&rules=%5B%22NO_POWERUPS%22%5D&inputs_source=defaults&bike=road&bike_reason=drafted&power=200%2C210%2C-1%2C250&race_from_s=1$/);
    const free = fakeFetch([{match: 'shelf.php', method: 'POST', status: 400, json: {success: false, error: 'Under 500 m to go: no plan needed, empty the tank.'}}]);
    await assert.rejects(() => shelfPlanFromHere(free, 'zgt_x', {kind: 'route', routeId: '1', remainingM: 300, power: []}), /Under 500 m/);
    assert.match(free.calls[0].body, /action=plan_here&kind=route&route_id=1&laps=1&distance_m=0&remaining_m=300&rules=%5B%5D&inputs_source=last&bike=road&power=&race_from_s=0/);
});
