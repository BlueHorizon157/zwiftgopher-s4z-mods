// The TT HUD's check for a newer version (pages/src/update-check.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, newestTag, fetchLatest, checkForUpdate, STORAGE_KEY, UPDATE_CHECK_MS, TIMEOUT_MS} from '../pages/src/update-check.mjs';

const answer = (status, json) => ({ok: status >= 200 && status < 300, status, json: async () => json});
function fakeFetch(routes) {
    const calls = [];
    const fn = async url => {
        calls.push(url);
        const hit = Object.entries(routes).find(([k]) => url.includes(k));
        if (!hit) {
            return answer(404, {message: 'Not Found'});
        }
        if (hit[1] instanceof Error) {
            throw hit[1];
        }
        return answer(200, hit[1]);
    };
    fn.calls = calls;
    return fn;
}
const memory = (initial = {}) => {
    const m = new Map(Object.entries(initial));
    return {get: k => m.get(k), set: (k, v) => m.set(k, v), m};
};

test('versions compare by number, not as text; a pre-release is older than its release', () => {
    assert.ok(compareVersions('0.10.0', '0.9.3') > 0);
    assert.ok(compareVersions('v0.9.4', '0.9.3') > 0, 'a leading v is ignored');
    assert.equal(compareVersions('0.9.3', 'v0.9.3'), 0);
    assert.ok(compareVersions('0.9.3', '0.9.3-alpha') > 0);
    assert.ok(compareVersions('0.9.2', '0.9.3') < 0);
});

test('the newest tag is the highest version, not the first by name', () => {
    assert.equal(newestTag([{name: 'v0.9.3'}, {name: 'v0.9.2'}, {name: 'v0.10.0'}, {name: 'v0.7.0-alpha'}]), '0.10.0');
    assert.equal(newestTag([{name: 'not-a-version'}]), null);
    assert.equal(newestTag(null), null);
});

test('the latest release is read first; without one, the tags', async () => {
    assert.equal(await fetchLatest(fakeFetch({'releases/latest': {tag_name: 'v0.9.4', draft: false}})), '0.9.4');
    const tagsOnly = fakeFetch({'/tags': [{name: 'v0.9.3'}, {name: 'v0.10.1'}]});
    assert.equal(await fetchLatest(tagsOnly), '0.10.1');
    assert.equal(tagsOnly.calls.length, 2);
    assert.equal(await fetchLatest(fakeFetch({'releases/latest': new Error('offline')})), null);
});

test('one check a day for all windows: a fresh answer is used as it is, an old one is asked again', async () => {
    const now = 1_800_000_000_000;
    const fresh = memory({[STORAGE_KEY]: {at: now - 3600_000, latest: '0.9.4'}});
    const none = fakeFetch({});
    assert.deepEqual(await checkForUpdate({fetchFn: none, storage: fresh, current: '0.9.3', now}), {latest: '0.9.4', available: true});
    assert.equal(none.calls.length, 0, 'no request within the day');
    assert.deepEqual(await checkForUpdate({fetchFn: none, storage: fresh, current: '0.9.4', now}), {latest: '0.9.4', available: false});

    const old = memory({[STORAGE_KEY]: {at: now - UPDATE_CHECK_MS - 1, latest: '0.9.3'}});
    const r = await checkForUpdate({fetchFn: fakeFetch({'releases/latest': {tag_name: 'v0.10.0'}}), storage: old, current: '0.9.3', now});
    assert.deepEqual(r, {latest: '0.10.0', available: true});
    assert.deepEqual(old.m.get(STORAGE_KEY), {at: now, latest: '0.10.0'});
});

test('a failed check keeps what was known and waits an hour before trying again', async () => {
    const now = 1_800_000_000_000;
    const store = memory({[STORAGE_KEY]: {at: now - 2 * UPDATE_CHECK_MS, latest: '0.9.4'}});
    const down = fakeFetch({'releases/latest': new Error('offline')});
    assert.deepEqual(await checkForUpdate({fetchFn: down, storage: store, current: '0.9.3', now}), {latest: '0.9.4', available: true});
    assert.equal(store.m.get(STORAGE_KEY).at, now - UPDATE_CHECK_MS + 3600_000);
    await checkForUpdate({fetchFn: down, storage: store, current: '0.9.3', now: now + 60_000});
    assert.equal(down.calls.length, 1, 'not asked again within the hour');
    assert.deepEqual(await checkForUpdate({fetchFn: down, storage: memory(), current: '0.9.3', now}), {latest: null, available: false}, 'nothing known: nothing shown');
});

test('windows that start together ask GitHub once between them (audit 11)', async () => {
    const store = memory();
    let requests = 0;
    const slow = async () => {
        requests++;
        await new Promise(resolve => setTimeout(resolve, 60));
        return answer(200, {tag_name: 'v1.0.1'});
    };
    const starts = [0, 5, 10, 20, 30, 40].map(ms => new Promise(resolve => setTimeout(resolve, ms)).then(() => checkForUpdate({fetchFn: slow, storage: store, current: '1.0.0'})));
    const results = await Promise.all(starts);
    assert.equal(requests, 1, 'one request');
    assert.deepEqual(results[0], {latest: '1.0.1', available: true}, 'the window that asked has the answer');
    // The others read it from the shared storage a little later.
    assert.deepEqual(await checkForUpdate({fetchFn: slow, storage: store, current: '1.0.0'}), {latest: '1.0.1', available: true});
    assert.equal(requests, 1);
});

test('a GitHub that never answers ends the check like a failed one (audit 11)', async () => {
    assert.ok(TIMEOUT_MS >= 1000);
    const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))));
    assert.equal(await fetchLatest(hang, 30), null);
});
