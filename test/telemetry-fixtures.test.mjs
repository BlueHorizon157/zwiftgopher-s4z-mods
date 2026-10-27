// Recordings under test/fixtures/telemetry: the recorder's JSONL (synthetic until Dave
// records a real TT). These checks pin the format the replayer and the engine read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseJsonl, metaOf, rpcCacheOf} from '../pages/src/replay.mjs';

const DIR = new URL('./fixtures/telemetry/', import.meta.url).pathname;
const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
const CHANNELS = new Set(['meta', 'rpc', 'athlete/watching', 'nearby']);

test('there are telemetry fixtures', () => {
    assert.ok(files.length >= 1);
});

for (const name of files) {
    test(`recording ${name} is well formed`, () => {
        const rows = parseJsonl(readFileSync(join(DIR, name), 'utf8'));
        assert.equal(rows[0].ch, 'meta', 'meta row first');
        const meta = metaOf(rows);
        assert.ok(Number(meta.startedAt) > 0, 'meta.startedAt');
        let lastT = -1;
        let lastEventDistance = -1;
        let watching = 0;
        for (const row of rows) {
            assert.ok(CHANNELS.has(row.ch), `channel ${row.ch}`);
            assert.ok(row.t >= lastT, 'time never goes backwards');
            lastT = row.t;
            if (row.ch === 'athlete/watching') {
                watching++;
                const s = row.d.state;
                assert.ok(Number.isFinite(s.power) && Number.isFinite(s.speed), 'power and speed');
                assert.ok(s.eventDistance >= lastEventDistance, 'eventDistance never goes backwards');
                lastEventDistance = s.eventDistance;
            }
        }
        assert.ok(watching > 60, 'at least a minute of the rider');
        if (meta.synthetic) {
            assert.ok(rpcCacheOf(rows).size >= 2, 'synthetic recordings carry the event RPCs');
        }
    });
}
