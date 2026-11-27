// The mod's live state, shared through Sauce: once a tick the target, the next change and the
// rider's place in the plan go into the rider's athlete data (updateAthleteData RPC) as `zgtt`,
// visible to anything that reads Sauce: athlete/v2/self, the athlete/self and watching streams.
//
// One window shares at a time (each engine window has its own engine; one opened mid-race may
// disagree): the first to start holds a heartbeat under '/zg-tt/share' in the mod's storage
// (shared-storage.mjs; not a store.mjs key, so no window redraws for it). When that window closes
// the heartbeat goes stale and another takes over.
//
// zgtt (version 1):
//   v          1
//   wt         world time (ms) of the tick it was made from: compare with state.worldTime
//   status     idle | armed | racing | finished
//   code, card, routeId, routeName     the plan (code null with no plan)
//   targetW    the target now, with the rider's bias (the first interval's before the plan)
//   planW      the same without the bias
//   number, intervals                  the interval (from 1) and how many
//   bias, offsetM                      the rider's controls
//   planM, remainingM                  where the rider is in the plan, and to the finish
//   raceS, deltaS                      race clock from the line; predicted finish against the plan's (+ slower)
//   next       {w, planW, inM, inS} the next change, or null on the last interval

export const SHARE_KEY = '/zg-tt/share';
export const HEARTBEAT_MS = 2000;   // the sharing window writes its heartbeat this often
export const STALE_MS = 5000;       // a heartbeat older than this: another window takes over
export const VERSION = 1;
export const RETRY_MS = 60000;      // wait after a failed updateAthleteData call

const round1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** What the view shares (null for a spectating view: the state is someone else's). */
export function sharedState(view, worldMs = null) {
    if (!view || view.spectating) {
        return null;
    }
    const plan = view.plan;
    const t = view.target;
    const n = view.next;
    return {
        v: VERSION,
        wt: Number.isFinite(worldMs) ? worldMs : null,
        status: view.status ?? 'idle',
        code: plan?.code ?? null,
        card: plan?.card ?? null,
        routeId: plan?.routeId ?? null,
        routeName: plan?.routeName ?? null,
        targetW: t ? round1(t.powerW) : null,
        planW: t ? round1(t.planPowerW) : null,
        number: t?.number ?? null,
        intervals: plan?.intervals ?? null,
        bias: view.controls?.bias ?? 1,
        offsetM: view.controls?.offsetM ?? 0,
        planM: round1(view.race?.planM),
        remainingM: round1(view.race?.remainingM),
        raceS: round1(view.race?.elapsedS),
        deltaS: round1(view.race?.deltaS),
        next: n ? {w: round1(n.powerW), planW: round1(n.planPowerW), inM: round1(n.inM), inS: round1(n.inS)} : null,
    };
}

/** One window's sharer: tick(viewFn, data) each tick (viewFn runs only while this window shares). */
export function createSharer({rpc, storage, id = Math.random().toString(36).slice(2), now = () => Date.now()}) {
    let lastBeat = 0;
    let failedAt = null;
    const sharing = () => {
        const t = now();
        const beat = storage?.get(SHARE_KEY);
        const mine = beat?.id === id;
        if (!mine && beat && Number.isFinite(beat.at) && t - beat.at < STALE_MS) {
            return false;
        }
        if (!mine || t - lastBeat >= HEARTBEAT_MS) {
            storage?.set(SHARE_KEY, {id, at: t});
            lastBeat = t;
        }
        return true;
    };
    return {
        id,
        get sharing() {
            const beat = storage?.get(SHARE_KEY);
            return beat?.id === id;
        },
        tick(viewFn, data) {
            if (!rpc?.updateAthleteData || (failedAt != null && now() - failedAt < RETRY_MS) || !sharing()) {
                return null;
            }
            failedAt = null;
            const state = sharedState(viewFn(), Number(data?.state?.worldTime) || null);
            if (!state) {
                return null;
            }
            Promise.resolve(rpc.updateAthleteData('self', {zgtt: state})).catch(err => {
                // Sauce lacks the call or is not answering: back off (one warning, not one a second).
                failedAt = now();
                console.warn('[share] updateAthleteData', err);
            });
            return state;
        },
        stop() {
            if (storage?.get(SHARE_KEY)?.id === id) {
                storage.set(SHARE_KEY, null);
            }
        },
    };
}
