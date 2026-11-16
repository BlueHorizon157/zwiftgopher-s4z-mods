// The mod's shared storage (pages/src/shared-storage.mjs): its keys out of Sauce's windows'
// way, heard by the mod's own windows, the old copies brought across without writing Sauce.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModStorage, LOCAL_PREFIX} from '../pages/src/shared-storage.mjs';

// Every '/zg-tt/...' key the mod's pages name (store.mjs needs Sauce, so its KEYS are read from the source).
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'src');
const files = dir => readdirSync(dir, {withFileTypes: true}).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const MOD_KEYS = [...new Set(files(src).filter(f => f.endsWith('.mjs'))
    .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/'(\/zg-tt\/[a-z-]+)'/g)].map(m => m[1])))];

function localStore() {
    const m = new Map();
    return {
        map: m,
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k),
    };
}

function sauceStore(initial = {}) {
    const m = new Map(Object.entries(initial));
    const writes = [];
    const listeners = [];
    return {
        writes,
        get: (k, def) => (m.has(k) ? m.get(k) : def),
        set: (k, v) => {
            writes.push(k);
            m.set(k, v);
        },
        delete: k => {
            writes.push(k);
            m.delete(k);
        },
        addEventListener: (type, fn) => listeners.push({type, fn}),
        fire: (key, value) => listeners.filter(l => l.type === 'globalupdate').forEach(l => l.fn({data: {key, value}})),
    };
}

function windowLike() {
    const fns = [];
    return {addEventListener: (type, fn) => type === 'storage' && fns.push(fn), storage: ev => fns.forEach(fn => fn(ev))};
}

// Sauce's own test of a storage event (pages/src/common.mjs LocalStorage._onStorage): global
// keys start with '/', a window's own keys with '<window id>-'. Anything else no Sauce window hears.
function sauceHears(key, windowId) {
    return key[0] === '/' || key.startsWith(`${windowId}-`);
}

test('the mod\'s keys live under ~zg-tt/, which no Sauce window hears', () => {
    const local = localStore();
    const s = createModStorage({local, sauce: sauceStore()});
    for (const key of ['/zg-tt/plans', '/zg-tt/active', '/zg-tt/controls', '/zg-tt/link', '/zg-tt/shelf', '/zg-tt/share',
        '/zg-tt/recorder', '/zg-tt/recorder-owner', '/zg-tt/update-check']) {
        assert.ok(MOD_KEYS.includes(key), `${key} is one of the mod's`);
    }
    for (const key of MOD_KEYS) {
        s.set(key, {x: 1});
        assert.deepEqual(s.get(key), {x: 1});
    }
    assert.equal(local.map.size, MOD_KEYS.length);
    for (const raw of local.map.keys()) {
        assert.ok(raw.startsWith(LOCAL_PREFIX), raw);
        for (const id of ['watching-1731790000000-1234567', 'nearby-1731790000000-42', 'browser-def-id', 'zwiftgopher-tt-hud-1731790000000-7']) {
            assert.equal(sauceHears(raw, id), false, `${raw} reaches ${id}`);
        }
    }
});

test('other keys stay in Sauce\'s storage; the old copies come across once, and Sauce is not written', () => {
    const local = localStore();
    const sauce = sauceStore({'/zg-tt/active': {code: 'G3Z3JP', card: null}, '/theme': 'dark', 'look': 3});
    const s = createModStorage({local, sauce});
    assert.equal(s.get('look'), 3);
    assert.equal(s.get('/theme'), 'dark');
    assert.deepEqual(s.get('/zg-tt/active'), {code: 'G3Z3JP', card: null});
    assert.equal(local.getItem('~zg-tt/active'), '{"code":"G3Z3JP","card":null}');
    assert.deepEqual(sauce.writes, []);
    s.set('/zg-tt/active', null);
    assert.equal(s.get('/zg-tt/active'), null); // kept as null, not read from Sauce again
    assert.equal(s.get('/zg-tt/plans'), undefined);
    assert.deepEqual(s.get('/zg-tt/plans', {plans: {}}), {plans: {}});
    s.set('look', 4);
    s.delete('/tt-dashboards/shared-state');
    assert.deepEqual(sauce.writes, ['look', '/tt-dashboards/shared-state']);
    // deleted: kept as null, so Sauce's old copy doesn't come back
    s.delete('/zg-tt/active');
    assert.equal(local.getItem('~zg-tt/active'), 'null');
    assert.equal(s.get('/zg-tt/active'), null);
    s.set('/zg-tt/share', undefined);
    assert.equal(s.get('/zg-tt/share'), null);
    assert.deepEqual(sauce.writes, ['look', '/tt-dashboards/shared-state']);
});

test('the mod\'s windows hear each other\'s writes as globalupdate, under the /zg-tt/ key', () => {
    const win = windowLike();
    const sauce = sauceStore();
    const s = createModStorage({local: localStore(), win, sauce});
    const heard = [];
    s.addEventListener('globalupdate', ev => heard.push([ev.data.key, ev.data.value]));
    win.storage({key: '~zg-tt/controls', newValue: '{"bias":1.02}'});
    win.storage({key: '~zg-tt/share', newValue: null});
    win.storage({key: 'watching-1-2-settings', newValue: '{}'}); // someone else's
    win.storage({key: '~zg-tt/broken', newValue: '{'});
    sauce.fire('/theme', 'light'); // Sauce's own global keys still come through
    sauce.fire('/zg-tt/controls', {bias: 1}); // an old mod writing Sauce's copy: not the mod's state now
    assert.deepEqual(heard, [['/zg-tt/controls', {bias: 1.02}], ['/zg-tt/share', undefined], ['/theme', 'light']]);
});
