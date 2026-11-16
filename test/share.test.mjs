// The live state shared through Sauce (pages/src/views/share.mjs): what goes into the rider's
// athlete data as `zgtt`, and one window sharing at a time.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sharedState, createSharer, SHARE_KEY, STALE_MS, HEARTBEAT_MS, RETRY_MS} from '../pages/src/views/share.mjs';

const view = (over = {}) => ({
    status: 'racing',
    spectating: false,
    plan: {code: 'HKX7PQ', card: 'balanced', routeId: '2737483381', routeName: 'Watopia Hilly Route', intervals: 11},
    controls: {bias: 1.02, offsetM: 10},
    target: {powerW: 195.636, planPowerW: 191.8, number: 1},
    next: {powerW: 214.2, planPowerW: 210, inM: 120.44, inS: 12.06},
    race: {planM: 760.55, remainingM: 5339.45, elapsedS: 80.04, deltaS: -1.26},
    ...over,
});

test('the state: target with and without the bias, the next change, the place in the plan', () => {
    assert.deepEqual(sharedState(view(), 1_000_000), {
        v: 1, wt: 1_000_000, status: 'racing', code: 'HKX7PQ', card: 'balanced',
        routeId: '2737483381', routeName: 'Watopia Hilly Route',
        targetW: 195.6, planW: 191.8, number: 1, intervals: 11, bias: 1.02, offsetM: 10,
        planM: 760.6, remainingM: 5339.5, raceS: 80, deltaS: -1.3,
        next: {w: 214.2, planW: 210, inM: 120.4, inS: 12.1},
    });
});

test('no plan, the last interval, and someone else\'s view', () => {
    const idle = sharedState({status: 'idle', spectating: false, plan: null, controls: {bias: 1, offsetM: 0}, target: null, next: null, race: {planM: null}}, 5);
    assert.equal(idle.code, null);
    assert.equal(idle.targetW, null);
    assert.equal(idle.status, 'idle');
    assert.equal(sharedState(view({next: null})).next, null);
    assert.equal(sharedState(view({spectating: true})), null);
    assert.equal(sharedState(null), null);
});

function world() {
    const store = new Map();
    const storage = {get: k => store.get(k) ?? null, set: (k, v) => store.set(k, v)};
    const calls = [];
    const rpc = {updateAthleteData: async (id, updates) => calls.push({id, updates})};
    let t = 0;
    return {storage, calls, rpc, clock: () => t, step: ms => (t += ms), store};
}

test('one window shares: the first to tick; another takes over when its heartbeat goes stale', async () => {
    const w = world();
    const a = createSharer({rpc: w.rpc, storage: w.storage, id: 'a', now: w.clock});
    const b = createSharer({rpc: w.rpc, storage: w.storage, id: 'b', now: w.clock});
    const data = {state: {worldTime: 42}};
    assert.ok(a.tick(() => view(), data));
    assert.equal(b.tick(() => assert.fail('b must not build a view'), data), null);
    await Promise.resolve();
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].id, 'self');
    assert.equal(w.calls[0].updates.zgtt.wt, 42);
    // a keeps its heartbeat fresh by ticking
    for (let i = 0; i < 5; i++) {
        w.step(1000);
        assert.ok(a.tick(() => view(), data));
        assert.equal(b.tick(() => view(), data), null);
    }
    assert.equal(w.store.get(SHARE_KEY).id, 'a');
    // a closes without a word: once its last heartbeat is stale, b shares
    w.step(w.store.get(SHARE_KEY).at + STALE_MS - 1 - w.clock());
    assert.equal(b.tick(() => view(), data), null);
    w.step(2);
    assert.ok(b.tick(() => view(), data));
    assert.equal(w.store.get(SHARE_KEY).id, 'b');
});

test('the heartbeat is written every couple of seconds, not every tick; stop hands over at once', () => {
    const w = world();
    let writes = 0;
    const storage = {get: w.storage.get, set: (k, v) => {
        writes++;
        w.storage.set(k, v);
    }};
    const a = createSharer({rpc: w.rpc, storage, id: 'a', now: w.clock});
    for (let i = 0; i < 10; i++) {
        a.tick(() => view(), {});
        w.step(1000);
    }
    assert.equal(writes, Math.ceil(10000 / HEARTBEAT_MS));
    a.stop();
    const b = createSharer({rpc: w.rpc, storage, id: 'b', now: w.clock});
    assert.ok(b.tick(() => view(), {}));
});

test('a Sauce without updateAthleteData: no call; a failing one is left alone for a minute', async () => {
    const w = world();
    assert.equal(createSharer({rpc: {}, storage: w.storage, id: 'a', now: w.clock}).tick(() => view(), {}), null);
    let calls = 0;
    const rpc = {updateAthleteData: async () => {
        calls++;
        throw new Error('no such method');
    }};
    const warn = console.warn;
    console.warn = () => {};
    try {
        const a = createSharer({rpc, storage: w.storage, id: 'a', now: w.clock});
        a.tick(() => view(), {});
        await new Promise(r => setTimeout(r, 0));
        w.step(1000);
        assert.equal(a.tick(() => view(), {}), null);
        w.step(RETRY_MS);
        assert.ok(a.tick(() => view(), {}));
        await new Promise(r => setTimeout(r, 0));
        assert.equal(calls, 2);
    } finally {
        console.warn = warn;
    }
});
