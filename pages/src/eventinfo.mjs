// What kind of event the rider is in and when it started (docs/REVAMP_PLAN.md 1.2), from
// Sauce's event RPCs, cached per subgroup. The engine takes it as event('eventInfo').
import {rpc} from './sauce.mjs';

const cache = new Map();

export async function fetchEventInfo(subgroupId) {
    const key = String(subgroupId);
    if (cache.has(key)) {
        return cache.get(key);
    }
    const promise = (async () => {
        let sg = null;
        let ev = null;
        try {
            sg = await rpc.getEventSubgroup(Number(subgroupId));
        } catch (err) {
            console.warn('[eventinfo] getEventSubgroup failed', err);
        }
        const eventId = sg?.eventId ?? sg?.event?.id ?? null;
        if (eventId != null) {
            try {
                ev = await rpc.getEvent(Number(eventId));
            } catch (err) {
                console.warn('[eventinfo] getEvent failed', err);
            }
        }
        const type = String(ev?.eventType ?? sg?.eventType ?? '').toUpperCase();
        const kind = type === 'TIME_TRIAL' || ev?.timeTrialOptions || sg?.timeTrialOptions ? 'tt' : (type ? 'group' : null);
        const startRaw = sg?.eventSubgroupStart ?? sg?.ts ?? ev?.eventStart ?? null;
        const startMs = typeof startRaw === 'number' ? startRaw : (startRaw ? Date.parse(startRaw) : NaN);
        return {
            subgroupId: key,
            kind,
            startMs: Number.isFinite(startMs) ? startMs : null,
            name: ev?.name ?? sg?.name ?? null,
            routeId: sg?.routeId ?? ev?.routeId ?? null,
            laps: sg?.laps ?? ev?.laps ?? null,
            distanceM: sg?.distanceInMeters ?? ev?.distanceInMeters ?? null,
        };
    })();
    cache.set(key, promise);
    return promise;
}
