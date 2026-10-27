import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseJsonl, createReplayer, rpcCacheOf, metaOf, FIXTURE_EPOCH_MS} from '../pages/src/replay.mjs';

const text = [
    JSON.stringify({t: 0, ch: 'meta', d: {recorder: 'test', startedAt: 1000}}),
    JSON.stringify({t: 0, ch: 'rpc', d: {method: 'getEventSubgroup', args: [5], result: {id: 5, ts: 123}}}),
    JSON.stringify({t: 0, ch: 'athlete/watching', d: {state: {power: 100}}}),
    JSON.stringify({t: 1000, ch: 'athlete/watching', d: {state: {power: 200}}}),
    JSON.stringify({t: 2500, ch: 'nearby', d: []}),
].join('\n') + '\n';

test('parseJsonl keeps rows in order and rejects a bad row', () => {
    const rows = parseJsonl(text);
    assert.equal(rows.length, 5);
    assert.equal(metaOf(rows).recorder, 'test');
    assert.throws(() => parseJsonl('{"x":1}\n'), /bad recording row/);
});

test('rpcCacheOf answers by method and arguments', () => {
    const cache = rpcCacheOf(parseJsonl(text));
    assert.deepEqual(cache.get('getEventSubgroup:[5]'), {id: 5, ts: 123});
    assert.equal(cache.has('getEventSubgroup:[6]'), false);
});

test('createReplayer delivers rows at recording time, scaled by speed, on the injected clock', () => {
    let real = 50_000;
    const timers = [];
    const setTimeout = (fn, ms) => timers.push({fn, at: real + ms});
    const seen = [];
    let done = false;
    const r = createReplayer(parseJsonl(text), {
        speed: 2,
        setTimeout,
        clearTimeout: () => {},
        realNow: () => real,
        onRow: row => seen.push(`${row.ch}@${row.t}`),
        onDone: () => { done = true; },
    });
    assert.equal(r.length, 3);
    assert.equal(r.now(), 1000, 'the clock starts at the recording start');
    r.start();
    assert.deepEqual(seen, ['athlete/watching@0']);
    let next = timers.shift();
    assert.equal(next.at, real + 500, '1000 ms of recording at 2x is 500 ms real');
    real = next.at;
    next.fn();
    assert.deepEqual(seen, ['athlete/watching@0', 'athlete/watching@1000']);
    assert.equal(r.now(), 2000);
    next = timers.shift();
    assert.equal(next.at, real + 750);
    real = next.at;
    next.fn();
    assert.equal(seen.length, 3);
    assert.equal(done, true);
    assert.equal(r.done, true);
    assert.equal(r.now(), 3500, 'the clock freezes at the end of the recording');
    real += 100_000;
    assert.equal(r.now(), 3500);
});

test('createReplayer without a meta start uses the fixture epoch', () => {
    const r = createReplayer(parseJsonl('{"t":0,"ch":"nearby","d":[]}\n'), {setTimeout: () => {}, realNow: () => 0});
    assert.equal(r.now(), FIXTURE_EPOCH_MS);
});

test('createReplayer seekMs delivers the earlier rows at once, then plays on', () => {
    let real = 10_000;
    const timers = [];
    const setTimeout = (fn, ms) => timers.push({fn, at: real + ms});
    const seen = [];
    const r = createReplayer(parseJsonl(text), {speed: 1, seekMs: 1500, realNow: () => real, setTimeout, clearTimeout: () => {}, onRow: row => seen.push(row.t)});
    r.start();
    assert.deepEqual(seen, [0, 1000]);
    assert.equal(r.elapsed(), 1500);
    assert.equal(r.now(), 1000 + 1500);
    real += 1000;
    timers.shift().fn();
    assert.deepEqual(seen, [0, 1000, 2500]);
    assert.equal(r.done, true);
});
