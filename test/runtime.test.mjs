// The engine windows' runtime (pages/src/views/runtime.mjs) with the real store, the real shelf
// sync and the real engine, over a recorded race (Fan Flats): what a sync that is under way when
// the race starts does, a plan chosen by hand when another window opens, the event info asked of
// Sauce, a planner that answers badly, the link a late 401 must not end. Audit of 2026-11-26.
import {test, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {sauceEnv, fakeFetch} from './helpers/sauce-env.mjs';

const env = sauceEnv();
const warn = console.warn;
const store = await import('../pages/src/store.mjs');
const {startWindow} = await import('../pages/src/views/runtime.mjs');
const {fetchPlanByCode} = await import('../pages/src/views/plan-loader.mjs');
after(() => env.restore());
beforeEach(() => {
    env.reset();
    console.warn = warn;
});

const dir = new URL('./fixtures/recordings/', import.meta.url);
const recording = gunzipSync(readFileSync(new URL('fan-flats-2026-11-18.jsonl.gz', dir))).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const meta = recording.find(r => r.ch === 'meta').d;
const home = recording.filter(r => r.ch === 'athlete/watching');
const info = recording.find(r => r.ch === 'rpc' && r.d.method === 'getEventSubgroup').d.result;
const plan = JSON.parse(readFileSync(new URL('fan-flats-2026-11-18.plan.json', dir), 'utf8'));
const hilly = JSON.parse(readFileSync(new URL('hilly-race-2026-11-11.planner.plan.json', dir), 'utf8'));
const joinIdx = home.findIndex(r => r.d.state.eventSubgroupId);
const lineIdx = home.findIndex(r => r.d.state.eventSubgroupId && r.d.state.time > 0 && r.d.state.eventDistance > 0 && r.d.state.eventDistance < 100);
const linked = {token: 'zgt_x', state: 'linked', zwiftId: 1, deviceId: 1, linkId: 1};

/** The tick of a recorded row, with the pen's (timer and distance at zero) when asked, in another subgroup when told. */
const tickOf = (row, {pen = false, sg} = {}) => {
    const d = structuredClone(row.d);
    if (pen) {
        d.state.time = 0;
        d.state.eventDistance = 0;
    }
    if (sg !== undefined) {
        d.state.eventSubgroupId = sg;
    }
    return d;
};
const feedRow = (clock, row, opts, windows = null) => {
    clock.set(meta.startedAt + row.t);
    if (windows) {
        windows.forEach(i => env.feedTo('athlete/watching', i, tickOf(row, opts)));
    } else {
        env.feed('athlete/watching', tickOf(row, opts));
    }
};
const settle = () => env.sleep(30);
const answer = json => ({status: 200, json, etag: 'W/"e"'});

test('a shelf sync that began in the pen changes nothing once the race is on: the plan stays and the race goes on (audit 2)', async () => {
    const clock = env.clock(meta.startedAt);
    env.stub.rpc = method => (method === 'getEventSubgroup' ? info : null);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = fakeFetch(async url => {
        if (url.includes('action=list')) {
            await gate;                                  // the planner is slow to answer
            return answer({success: true, plans: [], link: {}});   // and no longer lists the plan (removed, or expired)
        }
        return {status: 404};
    });
    store.savePlan('FANFLT', plan, {shelf: true, source: 'planner', publishedAt: '2026-11-18T10:00:00Z', expiresAt: new Date(meta.startedAt + 86400000).toISOString()});
    store.setLink(linked);
    const api = startWindow({render() {}});
    for (let i = 0; i <= joinIdx + 5; i++) {
        feedRow(clock, home[i], {pen: i >= joinIdx});
    }
    await settle();
    assert.equal(api.engine.state.status, 'armed');
    const poll = api.syncNow();                          // armed is quiet: the poll starts, the list request hangs
    for (let i = joinIdx + 6; i <= lineIdx + 30; i++) {
        feedRow(clock, home[i]);
    }
    assert.equal(api.engine.state.status, 'racing', 'the gun went while the request was out');
    release();
    await poll;
    assert.equal(api.engine.state.status, 'racing');
    assert.equal(api.engine.state.plan?.code, 'FANFLT', 'the engine still has its plan');
    assert.equal(store.getActiveCode(), 'FANFLT');
    assert.ok(store.getPlanEntry('FANFLT'), 'the library too');
    assert.equal(store.getShelf().etag ?? null, null, 'what was not applied is read again at the next poll');
});

test('a plan chosen by hand in the pen stays when another window is opened there (audit 5)', async () => {
    const clock = env.clock(meta.startedAt);
    env.stub.rpc = method => (method === 'getEventSubgroup' ? {...info, id: 7100001} : null);
    store.savePlan('EVENTX', {...plan, meta: {...(plan.meta ?? {}), event: {id: info.eventId, subgroup_id: 7100001}}}, {activate: false});
    store.savePlan('HANDYY', hilly, {activate: false});         // another plan, which the rider prefers
    const first = startWindow({render() {}});
    for (let i = 0; i < joinIdx + 4; i++) {
        feedRow(clock, home[i], {pen: i >= joinIdx, sg: i >= joinIdx ? 7100001 : undefined}, [0]);
    }
    await settle();
    assert.equal(store.getActiveCode(), 'EVENTX', 'joining the pen arms the plan made for the event');
    store.setActive('HANDYY');                          // the rider chooses a plan by hand: it stays
    const second = startWindow({render() {}});          // the field window, opened in the pen
    for (let i = joinIdx; i < joinIdx + 6; i++) {
        feedRow(clock, home[i], {pen: true, sg: 7100001}, [1]);
    }
    await settle();
    assert.equal(second.engine.state.event.infoFor, '7100001', 'the second window did get the event info');
    assert.equal(store.getActiveCode(), 'HANDYY', 'and did not pick over the rider\'s choice');
    assert.ok(first && second);
});

test('Sauce is asked again for the event info while it said nothing, and when the engine lost it by a re-join (audit 7)', async () => {
    const clock = env.clock(meta.startedAt);
    const sg = 7200001;
    let calls = 0;
    env.stub.rpc = method => {
        if (method !== 'getEventSubgroup') {
            return null;
        }
        if (++calls === 1) {
            throw new Error('Sauce could not reach Zwift');
        }
        return {...info, id: sg};
    };
    store.savePlan('FANFLT', plan, {});
    console.warn = () => {};                              // eventinfo.mjs says the failed ask
    const api = startWindow({render() {}});
    const pen = (i, back = false) => env.feed('athlete/watching', tickOf(home[joinIdx + (i % 5)], {pen: true, sg: back ? 0 : sg}));
    pen(0);
    await settle();
    assert.equal(calls, 1);
    assert.equal(api.engine.state.event.kind, null, 'the first answer said nothing');
    pen(1);
    await settle();
    assert.equal(calls, 1, 'not asked again straight away');
    clock.set(clock.now() + 11000);
    pen(2);
    await settle();
    assert.equal(calls, 2, 'asked again after a few seconds');
    assert.ok(api.engine.state.event.kind, 'the event info is in the engine now');
    assert.ok(api.engine.state.event.startMs);

    // Out of the event and back in the same pen: the engine forgets the event, the window asks again.
    pen(3, true);
    pen(4);
    await settle();
    assert.ok(api.engine.state.event.kind, 'the event info is back after the re-join');
    assert.ok(api.engine.state.event.startMs);
});

test('a planner that answered like one without a shelf is asked again after a while, not never (audit 8)', async () => {
    const clock = env.clock(Date.UTC(2026, 10, 28, 18, 0));
    let up = false;
    globalThis.fetch = fakeFetch(url => (url.includes('action=list') ? (up ? answer({success: true, plans: [], link: {}}) : {status: 404}) : {status: 404}));
    store.setLink(linked);
    const api = startWindow({render() {}});
    await api.syncNow();
    assert.equal(api.linkSupported(), false);
    const asked = () => globalThis.fetch.calls.filter(c => c.url.includes('action=list')).length;
    assert.equal(asked(), 1);
    up = true;
    clock.set(clock.now() + 60000);
    await api.syncNow();
    assert.equal(asked(), 1, 'not within the retry time');
    clock.set(clock.now() + 11 * 60000);
    await api.syncNow();
    assert.equal(asked(), 2, 'asked again');
    assert.equal(api.linkSupported(), true);
});

test('a plan from here the rider has left is put away in the window that saw it too (audit 10)', async () => {
    const clock = env.clock(Date.UTC(2026, 10, 28, 18, 0));
    const flat = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
    const t0 = clock.now();
    const here = {...flat, meta: {...(flat.meta ?? {}), from_here: {kind: 'route', remaining_m: 8000, cp_factor: 0.97,
        anchor: {ride_m: 1000, world_ms: t0, route_id: String(flat.route.id), subgroup_id: null}}}};
    store.savePlan('HERE01', here, {shelf: true, source: 'here'});
    store.setActive('HERE01');
    const api = startWindow({render() {}});
    const tick = (i, routeId) => ({athleteId: 1, athlete: {id: 1}, state: {eventSubgroupId: 0, time: i, eventDistance: 0, distance: 1000 + i * 10, worldTime: t0 + i * 1000, power: 250, speed: 40, routeId}, remaining: 5000, remainingType: 'route'});
    const feed = d => { clock.set(d.state.worldTime); env.feed('athlete/watching', d); };
    api.engine.event('home', {athleteId: 1});
    for (let i = 0; i < 5; i++) {
        feed(tick(i, flat.route.id));
    }
    assert.equal(api.engine.state.plan?.code, 'HERE01');
    for (let i = 5; i < 9; i++) {
        feed(tick(i, 999999));              // leaves the route
    }
    assert.equal(store.getActiveCode(), null);
    assert.equal(api.view().plan, null, 'this window\'s engine let the plan go too');
});

test('a 401 that comes back after a new pairing was started does not end the new link (minor)', async () => {
    env.clock(Date.UTC(2026, 10, 28, 18, 0));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = fakeFetch(async url => {
        if (url.includes('action=list')) {
            await gate;
            return {status: 401, json: {success: false, error: 'This link is not valid any more.'}};
        }
        return {status: 404};
    });
    store.setLink({...linked, token: 'zgt_old'});
    const api = startWindow({render() {}});
    const poll = api.syncNow();
    store.clearLink();                                   // Unlink, and Link to the planner again, while the request was out
    store.setLink({token: 'zgt_new', state: 'pending', code: 'ABC234', linkId: 2});
    release();
    await poll;
    assert.equal(store.getLink()?.token, 'zgt_new');
    assert.equal(store.getLink()?.state, 'pending');
});

test('the sign-ups are marked sent when the planner has them, and sent again when it did not (minor)', async () => {
    env.clock(Date.UTC(2026, 10, 28, 18, 0));
    env.stub.rpc = method => (method === 'getCachedEvents' ? [] : null);
    let planner = 500;
    globalThis.fetch = fakeFetch(url => {
        if (url.includes('shelf.php') && !url.includes('action=list')) {
            return planner === 200 ? {status: 200, json: {success: true, count: 0}} : {status: 500, json: {success: false}};
        }
        return {status: 404};
    });
    store.setLink(linked);
    startWindow({render() {}});
    await env.sleep(2700);                              // the first look at Sauce's events is at 2.5 s
    const signups = () => globalThis.fetch.calls.filter(c => /action=signups/.test(c.body ?? '')).length;
    assert.equal(signups(), 1);
    assert.notEqual(store.getShelf().signupsSent, '[]', 'the planner did not take them: not marked sent');
    // A minute on, another look: the planner takes them now.
    env.clock(Date.UTC(2026, 10, 28, 18, 1, 5));
    planner = 200;
    startWindow({render() {}});
    await env.sleep(2700);
    assert.equal(store.getShelf().signupsSent, '[]');
});

test('a share code whose answer stops arriving is a planner that did not answer, not "HTTP 200" (minor)', async () => {
    globalThis.fetch = async () => ({
        status: 200, ok: true,
        json: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; },
    });
    await assert.rejects(fetchPlanByCode('ABC234'), /did not answer in time/);
    // Text that is not JSON is still an answer with no plan.
    globalThis.fetch = async () => ({status: 200, ok: true, json: async () => JSON.parse('<html>')});
    await assert.rejects(fetchPlanByCode('ABC234'), /answered HTTP 200/);
});

test('a strategy chosen after the finish waits for the next ride, then is the one ridden (audit, HUD 5)', async () => {
    const clock = env.clock(meta.startedAt);
    env.stub.rpc = method => (method === 'getEventSubgroup' ? info : null);
    globalThis.fetch = fakeFetch(async () => ({status: 404}));
    store.savePlan('FANFLT', plan);
    const api = startWindow({render() {}});
    for (const row of home) {
        feedRow(clock, row);
        if (api.engine.state.status === 'finished') {
            break;
        }
    }
    await settle();
    assert.equal(api.engine.state.status, 'finished');
    const ridden = api.engine.state.plan.card ?? null;
    const next = ridden === 'fastest' ? 'safe_finish' : 'fastest';     // the plan as shared is Balanced
    assert.equal(api.setStrategy(next), true, 'taken after the finish');
    assert.equal(api.cardWaiting(), true, 'it waits');
    assert.equal(api.chosenCard(), next);
    assert.equal(api.engine.state.status, 'finished', 'the race just ridden is left as it was');
    assert.equal(api.engine.state.plan.card ?? null, ridden);
    api.reset();
    const last = home.at(-1);
    feedRow(clock, last);
    await settle();
    assert.equal(api.cardWaiting(), false);
    assert.equal(api.engine.state.plan.card, next, 'the next ride is on the strategy chosen');
});
