// Loads a plan by share code into the library: GET share-plan.php?action=load&code=... (only the
// code is sent), a timeout and one retry; a planner URL is accepted in place of a code.
import * as store from '../store.mjs';
import * as sauce from '../sauce.mjs';

// The planner's share endpoint; window.ZG_PLANNER_BASE (local stand-in) overrides the base.
export const SHARE_URL = 'https://zwiftgopher.com/TT/share-plan.php';
const shareUrl = () => (typeof window !== 'undefined' && window.ZG_PLANNER_BASE ? `${window.ZG_PLANNER_BASE}/share-plan.php` : SHARE_URL);
const TIMEOUT_MS = 8000;

export function parseCode(text) {
    const s = String(text ?? '').trim();
    const fromUrl = s.match(/[?&](?:plan|code)=([A-Za-z0-9]{6})/);
    const code = (fromUrl ? fromUrl[1] : s).toUpperCase();
    return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

// The planner's share-code alphabet: no I, O, 0 or 1.
const SHARE_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * A share code on the clipboard: the code as the planner shows it (upper case), or a planner
 * link holding one; else null. Reading needs the window focused; any failure is just no offer.
 */
export async function clipboardCode() {
    let text = '';
    try {
        text = String(await navigator.clipboard?.readText?.() ?? '').trim();
    } catch {
        return null;
    }
    if (!text || text.length > 400) {
        return null;
    }
    const fromUrl = /zwiftgopher/i.test(text) ? text.match(/[?&](?:plan|code)=([A-Za-z0-9]{6})\b/) : null;
    const code = fromUrl ? fromUrl[1].toUpperCase() : text;
    return SHARE_CODE.test(code) ? code : null;
}

/** Load a code into the library (active unless told otherwise); {code, raw, meta}. */
export async function loadPlanByCode(text, {activate = true, ...extra} = {}) {
    const loaded = await fetchPlanByCode(text);
    store.savePlan(loaded.code, loaded.raw, {activate, expiresAt: loaded.meta?.expires_at ?? null, ...extra});
    return loaded;
}

/** The plan for a code from the planner, not saved: {code, raw, meta}. A timeout, one retry. */
export async function fetchPlanByCode(text) {
    const code = parseCode(text);
    if (!code) {
        throw new Error('A plan code is six letters and digits.');
    }
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        try {
            const resp = await fetch(`${shareUrl()}?action=load&code=${code}`, {signal: ctl.signal});
            // Non-JSON text (a proxy page) counts as no plan; a body lost mid-read is rethrown.
            const body = await resp.json().catch(err => {
                if (err?.name === 'SyntaxError') {
                    return {};
                }
                throw err;
            });
            if (resp.status === 404) {
                throw new Error(`No plan for ${code}: it may have expired (codes last seven days).`);
            }
            if (!resp.ok || !body.success || !body.plan) {
                throw new Error(body.error || `The planner answered HTTP ${resp.status}.`);
            }
            return {code, raw: body.plan, meta: body.meta ?? null};
        } catch (err) {
            lastError = err.name === 'AbortError' ? new Error('The planner did not answer in time.') : err;
            if (/expired|six letters|answered HTTP 4/.test(lastError.message)) {
                break;
            }
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError;
}

/** In replay mode with ?plan=<fixture>, put that plan file in the library as REPLAY. */
export async function loadReplayPlan() {
    if (!sauce.isReplay || !sauce.replayPlan || !/^[\w.-]+$/.test(sauce.replayPlan)) {
        return null;
    }
    const res = await fetch(`./fixtures/${sauce.replayPlan}.json`);
    if (!res.ok) {
        throw new Error(`fixture plan ${sauce.replayPlan}: HTTP ${res.status}`);
    }
    const raw = await res.json();
    store.savePlan('REPLAY', raw);
    return raw;
}
