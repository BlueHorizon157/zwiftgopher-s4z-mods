// A window's part in keeping race recordings (race-keeper.mjs, recorder.mjs).
//
// Every engine window notes the events the rider rides in the shared marks, and, while the
// recorder runs, records its engine's view once a second ('zg/state') and its log lines
// ('zg/log'): the mod's own reading of the race, which the ticks alone do not give back (where
// it placed the rider, what it said, ahead or behind). Every 30 s the window that writes the
// ticks saves the races that are over, drops marks of no race, forgets old ones, and deletes
// kept races past their fortnight. Never in a replay. The recorder is passed in (recorder.mjs in
// the mod; a stand-in in the tests).
import {MARKS_KEY, observeTick, applyPatches, marksDue, viewSnapshot} from '../race-keeper.mjs';

const SNAPSHOT_MS = 1000;
const ZG_OWNER = 'zg';
const SAVE_TRIES = 5;             // a save that throws (the disk, the quota) is tried again at the next sweeps, this often

export function createRaceWatch({storage, engine, recorder}) {
    let local = null;
    let lastSnapshotMs = 0;
    const logged = new WeakSet();     // the engine's log entries already recorded (two can share a time)
    let sweeping = false;

    const writeMarks = patches => {
        const next = applyPatches(storage.get(MARKS_KEY), patches);
        if (next) {
            storage.set(MARKS_KEY, next);
        }
    };

    function tick(data, nowMs = Date.now()) {
        const st = engine.state;
        if (recorder.isKeeping() && !st.spectating) {
            const finished = st.status === 'finished';
            const {local: mem, patches} = observeTick(local, data, nowMs, {
                engineStatus: st.status,
                raceS: finished ? st.finishS : null,
                name: st.event?.name ?? null,
                code: st.plan?.code ?? null,
            });
            local = mem;
            writeMarks(patches);
        }
        if (!recorder.isActive()) {
            return;
        }
        // The engine's log since the last tick, then its view once a second.
        for (const entry of st.log ?? []) {
            if (entry && typeof entry === 'object' && !logged.has(entry)) {
                logged.add(entry);
                recorder.record('zg/log', {t: entry.t, msg: entry.msg}, {owner: ZG_OWNER});
            }
        }
        if (nowMs - lastSnapshotMs >= SNAPSHOT_MS) {
            lastSnapshotMs = nowMs;
            const course = st.course;
            recorder.record('zg/state', viewSnapshot(engine.view(), {
                locked: course ? Boolean(course.locked) : null,
                carried: course ? Boolean(course.carried) : null,
            }), {owner: ZG_OWNER});
        }
    }

    /** Saves the races that are over (the window writing the ticks only); returns what it did. */
    async function sweep(nowMs = Date.now()) {
        if (sweeping || !recorder.isKeeping() || !recorder.writesChannel('athlete/watching', nowMs)) {
            return null;
        }
        sweeping = true;
        try {
            const due = marksDue(storage.get(MARKS_KEY), nowMs);
            const patches = [];
            const saved = [];
            for (const mark of due.save) {
                let summary = null;
                try {
                    summary = await recorder.saveRace(mark);
                } catch (err) {
                    // Not done: the race is saved at a later sweep (SAVE_TRIES, then given up).
                    const tries = (mark.saveTries ?? 0) + 1;
                    console.warn(`[race-watch] save failed (${tries} of ${SAVE_TRIES})`, err);
                    patches.push(tries >= SAVE_TRIES ? {key: mark.key, doneAt: nowMs, saved: false, saveTries: tries} : {key: mark.key, saveTries: tries});
                    continue;
                }
                if (summary) {
                    saved.push(summary);
                }
                patches.push({key: mark.key, doneAt: nowMs, saved: Boolean(summary)});
            }
            for (const key of due.drop) {
                patches.push({key, doneAt: nowMs, saved: false});
            }
            if (patches.length || due.forget.length) {
                const marks = applyPatches(storage.get(MARKS_KEY), patches) ?? {...(storage.get(MARKS_KEY) ?? {})};
                for (const key of due.forget) {
                    delete marks[key];
                }
                storage.set(MARKS_KEY, marks);
            }
            const expired = await recorder.expireRaces(nowMs).catch(() => []);
            return {saved, dropped: due.drop, forgotten: due.forget, expired};
        } finally {
            sweeping = false;
        }
    }

    return {tick, sweep};
}
