// The TT HUD's check for a newer version (pages/src/update-check.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, newestTag, fetchLatest, checkForUpdate, STORAGE_KEY, UPDATE_CHECK_MS} from '../pages/src/update-check.mjs';

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
