// A replay window (?replay=) in the pages of a real profile: it plays a recorded race and may
// arm or put away plans, reset, nudge the controls, but all of it stays in the window. The plans,
// the active plan, the controls and the link the real windows share are not written (audit 6:
// the replay of last week's race put away the plan armed for tonight's). One test: a process
// plays one replay.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {sauceEnv, fakeFetch} from './helpers/sauce-env.mjs';

const env = sauceEnv({search: '?replay=past-race&speed=200'});
after(() => env.restore());
const store = await import('../pages/src/store.mjs');
const {startWindow} = await import('../pages/src/views/runtime.mjs');

const dir = new URL('./fixtures/recordings/', import.meta.url);
const text = gunzipSync(readFileSync(new URL('fan-flats-2026-11-18.jsonl.gz', dir))).toString('utf8');
const tonight = JSON.parse(readFileSync(new URL('hilly-race-2026-11-11.planner.plan.json', dir), 'utf8'));

test('a replay window writes nothing the real windows share (audit 6)', async () => {
    globalThis.fetch = fakeFetch(url => (url.includes('fixtures/past-race.jsonl') ? {status: 200, text} : {status: 404}));
    store.savePlan('TONITE', tonight, {});                       // the plan armed for tonight's event: another course than the replay's
    store.setLink({token: 'zgt_x', state: 'linked', linkId: 1, zwiftId: 1});
    const before = [...env.files];
    const api = startWindow({render() {}});
    await env.sleep(1500);                                       // the replay joins the pen of its event in the first moments
    assert.ok(api.messages.some(m => /put away/.test(m.msg)), 'the window acted on the event: the plan was put away there');
    api.nudgeBias(1);
    api.nudgeOffset(1);
    api.reset();
    assert.equal(store.getActiveCode(), null, 'in the replay window the plan is put away');
    assert.equal(store.getControls().bias, 1.01, 'its controls are its own');
    assert.deepEqual([...env.files], before, 'the real storage is as it was');
    assert.equal(store.getLink()?.state, 'linked', 'the replay sees the link');
    env.reset();
});
