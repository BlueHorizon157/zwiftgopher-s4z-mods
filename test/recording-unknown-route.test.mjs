// A Sauce build that does not know the event's route (routes ship with each Sauce release, so a
// route newer than the build is unknown) has no length for the event: its distance to go is
// endDistance - eventDistance with endDistance undefined, NaN, which reaches the mod as null over
// JSON, with remainingMetric still 'distance' and no remainingEnd. 0.7.0 to 0.8.2 read
// Number(null) = 0 as "nothing left" and ended the race at the timing line (a user, 2026-11-10,
// on California Dreamin'). The race must run to the plan's end instead.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {parseJsonl, metaOf} from '../pages/src/replay.mjs';

const dir = new URL('./fixtures/recordings/', import.meta.url);
const rows = parseJsonl(gunzipSync(readFileSync(new URL('california-dreamin-2026-11-10.jsonl.gz', dir))).toString('utf8'));
const meta = metaOf(rows);
const home = rows.filter(r => r.ch === 'athlete/watching');
const LINE_T_MS = 148100;     // the first tick past the timing line
const FINISH_T_MS = 2243000;  // about where the game's clock reads 2095 s

/** What a Sauce without the route sends: the same tick, the event's length gone. */
function unknownRoute(d) {
    const o = structuredClone(d);
    if (o.remainingType === 'event') {
        o.remaining = null;
        delete o.remainingEnd;
    }
    return o;
}

function statusChanges(plan) {
    const engine = createEngine({plan, prefs: {smoothingSec: 0}});
    const changes = [];
    for (const row of home) {
        engine.tick(unknownRoute(row.d), meta.startedAt + row.t);
        const status = engine.view().status;
        if (status !== changes.at(-1)?.status) {
            changes.push({status, t: row.t});
        }
    }
    return changes;
}

for (const [name, file] of [['a plan made before the course update', 'california-dreamin-2026-11-10.plan.json'],
    ['a plan with the course', 'california-dreamin-2026-11-10.planner.plan.json']]) {
    test(`no event length from Sauce: ${name} races from the line to the finish`, () => {
        const plan = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
        const changes = statusChanges(plan);
        const racing = changes.find(c => c.status === 'racing');
        const finished = changes.find(c => c.status === 'finished');
        assert.ok(racing && Math.abs(racing.t - LINE_T_MS) < 1000, `racing at the line: ${JSON.stringify(changes)}`);
        assert.ok(finished && finished.t > FINISH_T_MS - 5000, `finished at the end, not the line: ${JSON.stringify(changes)}`);
    });
}
