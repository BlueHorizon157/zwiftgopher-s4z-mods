// A stand-in for Sauce's common.mjs in Node (the part the mod uses): the state is on
// globalThis.__sauceStub, where sauce-env.mjs and the tests reach it.
const state = (globalThis.__sauceStub ??= {storage: new Map(), subs: {}, rpcCalls: [], rpc: null, visible: true});

export const storage = {
    get: (key, def) => (state.storage.has(key) ? state.storage.get(key) : def),
    set: (key, value) => state.storage.set(key, value),
    delete: key => state.storage.delete(key),
    addEventListener() {},
    removeEventListener() {},
};
export const settingsStore = null;
export const rpc = new Proxy({}, {
    get: (_, method) => async (...args) => {
        state.rpcCalls.push({method, args});
        return state.rpc ? state.rpc(method, args) : null;
    },
});
export function subscribe(channel, callback) {
    (state.subs[channel] ??= []).push(callback);
}
export function unsubscribe() {}
export function initInteractionListeners() {}
export function isVisible() {
    return state.visible;
}
