// A stand-in for Sauce4Zwift's /pages/src/common.mjs, so the mod's windows run in a plain
// browser for screenshots and checks without Sauce (scripts/sauce-standin/server.mjs). It has
// only what the mod uses: storage (global, across windows, via localStorage and its 'storage'
// event), the settings stores and form binding, a few RPCs answered from localStorage, and
// no-op subscriptions (the windows' ?replay= mode feeds telemetry itself).
//
// localStorage keys the shots script sets: standin:planner (the planner's base URL),
// standin:events (what rpc.getCachedEvents answers), standin:athlete (rpc.getAthlete('self')).

const read = key => {
    try {
        const v = localStorage.getItem(key);
        return v == null ? undefined : JSON.parse(v);
    } catch {
        return undefined;
    }
};
const planner = read('standin:planner');
if (planner) {
    window.ZG_PLANNER_BASE = planner;
}

function event(type, data) {
    const ev = new Event(type);
    ev.data = data;
    return ev;
}

class GlobalStorage extends EventTarget {
    get(key) {
        const v = read(`sauce:${key}`);
        return v === undefined ? null : v;
    }
    set(key, value) {
        localStorage.setItem(`sauce:${key}`, JSON.stringify(value ?? null));
        this.dispatchEvent(event('globalupdate', {key, value}));
    }
    delete(key) {
        localStorage.removeItem(`sauce:${key}`);
        this.dispatchEvent(event('globalupdate', {key, value: null}));
    }
}
export const storage = new GlobalStorage();
window.addEventListener('storage', ev => {
    if (ev.key?.startsWith('sauce:')) {
        storage.dispatchEvent(event('globalupdate', {key: ev.key.slice(6), value: ev.newValue == null ? null : JSON.parse(ev.newValue)}));
    }
});

export class SettingsStore extends EventTarget {
    constructor(key) {
        super();
        this.key = `settings:${key}`;
        window.addEventListener('storage', ev => {
            if (ev.key === this.key) {
                this.dispatchEvent(event('changed', {changed: new Map()}));
            }
        });
    }
    get(name) {
        const all = read(this.key) ?? {};
        return name === undefined ? all : all[name];
    }
    set(name, value) {
        const all = read(this.key) ?? {};
        all[name] = value;
        localStorage.setItem(this.key, JSON.stringify(all));
        this.dispatchEvent(event('changed', {changed: new Map([[name, value]])}));
    }
    setDefault(defaults) {
        const all = {...defaults, ...(read(this.key) ?? {})};
        localStorage.setItem(this.key, JSON.stringify(all));
    }
}

const ownKey = document.documentElement.dataset.settingsKey;
export const settingsStore = ownKey ? new SettingsStore(ownKey) : null;

export function initSettingsForm(form, {store}) {
    const fields = [...form.querySelectorAll('input[name], select[name]')];
    for (const el of fields) {
        el.addEventListener('change', () => {
            const value = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number') ? Number(el.value) : el.value;
            store.set(el.name, value);
        });
    }
    return async () => {
        for (const el of fields) {
            const v = store.get(el.name);
            if (v === undefined) {
                continue;
            }
            if (el.type === 'checkbox') {
                el.checked = Boolean(v);
            } else {
                el.value = String(v);
            }
            const out = form.querySelector(`.display-field[name="${el.name}"]`);
            if (out) {
                out.textContent = String(v);
            }
        }
    };
}

const answers = {
    getAthlete: ident => (ident === 'self' ? read('standin:athlete') ?? {id: 354912, firstName: 'Sample', lastName: 'Rider', sanitizedFullname: 'Sample Rider'} : null),
    getCachedEvents: () => read('standin:events') ?? [],
    loadNewerEvents: () => [],
};
export const rpc = new Proxy({}, {
    get: (_, method) => async (...args) => (answers[method] ? answers[method](...args) : null),
});

export function subscribe() {}
export function unsubscribe() {}
export function initInteractionListeners() {}
export function isVisible() {
    return document.visibilityState !== 'hidden';
}
