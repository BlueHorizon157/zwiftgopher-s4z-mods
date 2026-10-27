// Replay of a telemetry recording (docs/REVAMP_PLAN.md Phase 0.3).
//
// A recording is JSONL: one row per line, {t, ch, d} with t in ms from the recording's
// start, ch the Sauce channel ('athlete/watching', 'nearby'), or 'rpc' for a recorded RPC
// result ({method, args, result}) or 'meta' for the header. This module is pure: the
// timers and the clock are injected, so Node tests drive it and the windows use it through
// sauce.mjs in ?replay= mode.

export const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

export function parseJsonl(text) {
    const rows = [];
    for (const line of String(text).split('\n')) {
        const s = line.trim();
        if (!s) {
            continue;
        }
        const row = JSON.parse(s);
        if (typeof row?.t !== 'number' || typeof row?.ch !== 'string') {
            throw new Error(`bad recording row: ${s.slice(0, 80)}`);
        }
        rows.push(row);
    }
    return rows;
}

export function metaOf(rows) {
    return rows.find(r => r.ch === 'meta')?.d ?? null;
}

export function rpcKey(method, args) {
    return `${method}:${JSON.stringify(args ?? [])}`;
}

// Recorded RPC results by method and arguments, for sauce.rpc in replay mode.
export function rpcCacheOf(rows) {
    const cache = new Map();
    for (const row of rows) {
        if (row.ch === 'rpc' && row.d?.method) {
            cache.set(rpcKey(row.d.method, row.d.args), row.d.result);
        }
    }
    return cache;
}

// Plays the data rows in order at `speed` times real time. now() is the recording's
// clock (its start plus the elapsed recording time) so a window can run on it. seekMs
// fast-forwards: everything recorded before it is delivered on start, then play is live.
export function createReplayer(rows, {
    speed = 1,
    seekMs = 0,
    onRow = null,
    onDone = null,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
    realNow = () => Date.now(),
} = {}) {
    const meta = metaOf(rows);
    const epoch = Number(meta?.startedAt) || FIXTURE_EPOCH_MS;
    const play = rows.filter(r => r.ch !== 'meta' && r.ch !== 'rpc');
    const lastT = play.length ? play[play.length - 1].t : 0;
    let startedReal = null;
    let timer = null;
    let index = 0;

    // seekMs: the rows before it are delivered at once on start (a mid-race screenshot).
    const skip = Math.max(0, Math.min(lastT, Number(seekMs) || 0));
    const elapsed = () => startedReal == null ? 0 : Math.min(lastT, skip + (realNow() - startedReal) * speed);

    function step() {
        timer = null;
        while (index < play.length && play[index].t <= elapsed()) {
            const row = play[index++];
            onRow?.(row);
        }
        if (index >= play.length) {
            onDone?.();
            return;
        }
        timer = setTimeout(step, Math.max(0, (play[index].t - elapsed()) / speed));
    }

    return {
        start() {
            if (startedReal != null) {
                return;
            }
            startedReal = realNow();
            step();
        },
        stop() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            index = play.length;
        },
        now: () => epoch + elapsed(),
        elapsed,
        get done() {
            return index >= play.length;
        },
        get length() {
            return play.length;
        },
        meta,
        speed,
    };
}
