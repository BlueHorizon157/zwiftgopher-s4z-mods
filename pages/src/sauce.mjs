// The mod's one door to Sauce4Zwift: subscribe, rpc and storage from /pages/src/common.mjs,
// with two additions (docs/REVAMP_PLAN.md Phase 0):
//   ?replay=<name>[&speed=N]  plays pages/fixtures/<name>.jsonl (or the recorder's own
//                             buffer with ?replay=idb) instead of live data, and runs the
//                             window's clock (Date.now) on the recording's time;
//   subscribe(..., {record: true})  feeds the telemetry recorder from that subscription.
import * as common from '/pages/src/common.mjs';
import * as recorder from './recorder.mjs';
import {parseJsonl, createReplayer, rpcCacheOf, rpcKey} from './replay.mjs';

const params = new URLSearchParams(window.location.search);
export const replayName = params.get('replay');
export const replaySpeed = Math.max(0.1, Number(params.get('speed')) || 1);
// ?seek=<seconds> fast-forwards the recording to that point before playing (page-check.mjs).
export const replaySeekS = Math.max(0, Number(params.get('seek')) || 0);
export const isReplay = Boolean(replayName);
// ?plan=<name> with ?replay= loads pages/fixtures/<name>.json as the plan (page-check.mjs).
export const replayPlan = params.get('plan');

const listeners = new Map();
const wrappers = new WeakMap();
let replayer = null;
let replayRpc = new Map();
let replayLoading = null;

export function subscribe(channel, callback, {record = false, ...options} = {}) {
    if (!isReplay) {
        let cb = callback;
        if (record) {
            cb = data => {
                recorder.record(channel, data);
                callback(data);
            };
            wrappers.set(callback, cb);
        }
        return common.subscribe(channel, cb, options);
    }
    if (!listeners.has(channel)) {
        listeners.set(channel, new Set());
    }
    listeners.get(channel).add(callback);
    replayLoading ??= startReplay().catch(err => console.error('[replay] failed', err));
}

export function unsubscribe(channel, callback) {
    if (!isReplay) {
        return common.unsubscribe(channel, wrappers.get(callback) ?? callback);
    }
    listeners.get(channel)?.delete(callback);
}

export const rpc = new Proxy({}, {
    get(_, method) {
        return async (...args) => {
            if (isReplay) {
                const key = rpcKey(method, args);
                if (replayRpc.has(key)) {
                    return replayRpc.get(key);
                }
            }
            const result = await common.rpc[method](...args);
            if (!isReplay) {
                recorder.record('rpc', {method, args, result});
            }
            return result;
        };
    },
});

export const storage = common.storage;
export {common};

export function replayState() {
    return replayer ? {name: replayName, speed: replaySpeed, elapsed: replayer.elapsed(), done: replayer.done, length: replayer.length} : null;
}

async function startReplay() {
    const text = replayName === 'idb' ? await recorder.exportJsonl() : await loadFixture(replayName);
    const rows = parseJsonl(text);
    replayRpc = rpcCacheOf(rows);
    const realNow = Date.now.bind(Date);
    replayer = createReplayer(rows, {
        speed: replaySpeed,
        seekMs: replaySeekS * 1000,
        realNow,
        onRow: row => dispatch(row.ch, row.d),
        onDone: () => console.info('[replay] done'),
    });
    // The window's clock follows the recording, so interval timing is right at any speed.
    Date.now = () => replayer.now();
    document.documentElement.classList.add('replay-mode');
    console.info(`[replay] ${replayName}: ${replayer.length} rows at ${replaySpeed}x`);
    replayer.start();
}

async function loadFixture(name) {
    if (!/^[\w.-]+$/.test(name)) {
        throw new Error(`bad replay name: ${name}`);
    }
    const res = await fetch(`./fixtures/${name}.jsonl`);
    if (!res.ok) {
        throw new Error(`fixture ${name}: HTTP ${res.status}`);
    }
    return res.text();
}

function dispatch(channel, data) {
    for (const cb of listeners.get(channel) ?? []) {
        try {
            cb(data);
        } catch (err) {
            console.error('[replay] listener failed', err);
        }
    }
}
