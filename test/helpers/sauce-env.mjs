// Runs the mod's pages (store.mjs, sauce.mjs, views/runtime.mjs) in Node: a browser-like scope
// (window, document, a localStorage in memory) and Sauce's common.mjs from common-stub.mjs.
// Call sauceEnv() before the first import of a page module (they read window at load); a test
// file is a process of its own, so ?replay= is a file of its own too (sauceEnv({search})).
//
//   const env = sauceEnv();
//   const store = await import('../pages/src/store.mjs');
//   test('...', () => { env.reset(); ... });
//
// The windows' timers are tracked and cleared by reset(), so one test's windows do not run on
// into the next one's; env.sleep() waits on the real clock.
import {register} from 'node:module';

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const realNow = Date.now;
const realFetch = globalThis.fetch;

export const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

export function sauceEnv({search = ''} = {}) {
    register('./sauce-hooks.mjs', import.meta.url);
    const state = (globalThis.__sauceStub ??= {storage: new Map(), subs: {}, rpcCalls: [], rpc: null, visible: true});
    const files = new Map();
    globalThis.localStorage = {
        get length() {
            return files.size;
        },
        key: i => [...files.keys()][i] ?? null,
        getItem: key => (files.has(key) ? files.get(key) : null),
        setItem: (key, value) => files.set(key, String(value)),
        removeItem: key => files.delete(key),
    };
    const listeners = {};
    globalThis.window = {
        location: {search},
        localStorage: globalThis.localStorage,
        addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    };
    globalThis.document = {
        documentElement: {dataset: {}, classList: {add() {}}, style: {setProperty() {}}},
        body: {style: {setProperty() {}}},
        visibilityState: 'visible',
        addEventListener() {},
    };
    const timers = new Set();
    globalThis.setTimeout = (fn, ms, ...args) => {
        const t = realSetTimeout(fn, ms, ...args);
        timers.add(t);
        if (ms >= 1000) {
            t.unref?.();
        }
        return t;
    };
    globalThis.setInterval = (fn, ms, ...args) => {
        const t = realSetInterval(fn, ms, ...args);
        timers.add(t);
        t.unref?.();
        return t;
    };
    const notFound = async () => ({status: 404, ok: false, text: async () => '', json: async () => ({}), headers: {get: () => null}});
    globalThis.fetch = notFound;
    const env = {
        files,
        stub: state,
        sleep,
        /** Everything back to a clean start: storage, subscriptions, RPCs, timers, the clock and fetch. */
        reset() {
            files.clear();
            state.storage.clear();
            state.subs = {};
            state.rpcCalls.length = 0;
            state.rpc = null;
            state.visible = true;
            for (const t of timers) {
                realClearTimeout(t);
                realClearInterval(t);
            }
            timers.clear();
            Date.now = realNow;
            globalThis.fetch = notFound;
        },
        /** The clock the pages see: a fixed time, moved by clock.set(ms). */
        clock(startMs) {
            let t = startMs;
            Date.now = () => t;
            return {set: ms => { t = ms; }, now: () => t};
        },
        /** One tick to every window listening to the channel (a copy of data each). */
        feed(channel, data) {
            for (const cb of [...(state.subs[channel] ?? [])]) {
                cb(structuredClone(data));
            }
        },
        /** One tick to the nth window that subscribed since the last reset (windows start in order). */
        feedTo(channel, index, data) {
            state.subs[channel][index](structuredClone(data));
        },
        /** window.dispatchEvent for the listeners the pages added. */
        fire(type, ev = {}) {
            for (const fn of listeners[type] ?? []) {
                fn(ev);
            }
        },
        restore() {
            globalThis.setTimeout = realSetTimeout;
            globalThis.setInterval = realSetInterval;
            Date.now = realNow;
            globalThis.fetch = realFetch;
        },
    };
    return env;
}

/** A fetch answering from a function: handler(url, init) -> {status, json?, text?, etag?} (or a promise of it). */
export function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null});
        const hit = await handler(String(url), init);
        if (hit instanceof Error) {
            throw hit;
        }
        const body = hit.text ?? (hit.json !== undefined ? JSON.stringify(hit.json) : '');
        return {
            status: hit.status, ok: hit.status >= 200 && hit.status < 300,
            text: async () => body,
            json: async () => JSON.parse(body),
            headers: {get: name => (name === 'ETag' ? hit.etag ?? null : null)},
        };
    };
    fn.calls = calls;
    return fn;
}
