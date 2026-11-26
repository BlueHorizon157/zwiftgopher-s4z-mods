// The plan library and the planner link in the mod's shared storage (pages/src/store.mjs), as the
// shelf sync uses them: what a new link, an empty or short listing, an expired plan and a full
// library do to the plans and the active plan. Audit of 2026-11-26 (findings 1, 2, 4 and the
// removed-by-hand minor).
import {test, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sauceEnv} from './helpers/sauce-env.mjs';

const env = sauceEnv();
const store = await import('../pages/src/store.mjs');
const {syncOnce} = await import('../pages/src/views/shelf-sync.mjs');
after(() => env.restore());
beforeEach(() => env.reset());

const base = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
const raw = (n, extra = {}) => ({...base, route: {...base.route, id: 1000 + n, laps: 1}, ...extra});
const HOUR = 3600 * 1000;

const listing = plans => async url => (String(url).includes('action=list')
    ? {status: 200, ok: true, text: async () => JSON.stringify({success: true, plans, link: {}}), headers: {get: () => 'W/"e"'}}
    : {status: 200, ok: true, text: async () => '{"success":true}', headers: {get: () => null}});
const shelfLibrary = () => ({has: store.getPlanEntry, save: (code, file, meta) => store.savePlan(code, file, {activate: false, ...meta}), prune: store.pruneShelf});

test('a new link, or the end of one, leaves the plans of the old shelf in the library: the new listing is empty and must not take them (audit 1)', async () => {
    for (const n of [1, 2, 3]) {
        store.savePlan(`SHELF${n}`, raw(n), {activate: false, shelf: true, source: 'planner'});
    }
    store.savePlan('BYCODE', raw(4), {activate: false});
    store.setActive('SHELF1');
    store.setLink({token: 'zgt_old', state: 'linked', linkId: 7, zwiftId: 1});
    // Unlink, then link again: the planner makes a new link (a new link id) with a shelf of its own.
    store.clearLink();
    store.setLink({token: 'zgt_new', state: 'pending', linkId: 8, zwiftId: 1});
    const r = await syncOnce({fetchFn: listing([]), token: 'zgt_new', library: shelfLibrary(), loadPlan: async () => ({})});
    assert.deepEqual(r.removed, [], 'nothing leaves');
    assert.deepEqual(store.listPlans().map(p => p.code).sort(), ['BYCODE', 'SHELF1', 'SHELF2', 'SHELF3']);
    assert.equal(store.getActiveCode(), 'SHELF1', 'the active plan is still active');

    // A new pairing started over the old link (an expired code, no unlink in between) does the same.
    store.savePlan('SHELF9', raw(9), {activate: false, shelf: true});
    store.setLink({token: 'zgt_a', state: 'linked', linkId: 20});
    store.setLink({token: 'zgt_b', state: 'pending', linkId: 21});
    assert.equal(store.getPlanEntry('SHELF9').shelf, false);
    // The same link, going from pending to linked, changes nothing.
    store.savePlan('SHELF8', raw(8), {activate: false, shelf: true});
    store.setLink({token: 'zgt_b', state: 'linked', linkId: 21});
    assert.equal(store.getPlanEntry('SHELF8').shelf, true);
});

test('a plan that has left the shelf listing is not removed when it is the active plan, or has expired; a replaced or taken-off one still goes (audit 2)', async () => {
    const now = Date.UTC(2026, 10, 28, 18, 0);
    env.clock(now);
    store.savePlan('ACTIVE', raw(1), {activate: false, shelf: true, expiresAt: new Date(now + 3 * 24 * HOUR).toISOString()});
    store.savePlan('EXPIRED', raw(2), {activate: false, shelf: true, expiresAt: '2026-11-28 17:00:00'});          // the share endpoint's SQL text, UTC
    store.savePlan('EXPIREDISO', raw(3), {activate: false, shelf: true, expiresAt: new Date(now - HOUR).toISOString()});
    store.savePlan('GONE', raw(4), {activate: false, shelf: true, expiresAt: new Date(now + 2 * 24 * HOUR).toISOString()});
    store.savePlan('NOEXPIRY', raw(5), {activate: false, shelf: true});
    store.setActive('ACTIVE');
    assert.deepEqual(store.pruneShelf([]).sort(), ['GONE', 'NOEXPIRY'], 'only what the planner replaced or removed');
    assert.deepEqual(store.listPlans().map(p => p.code).sort(), ['ACTIVE', 'EXPIRED', 'EXPIREDISO']);
    assert.equal(store.getActiveCode(), 'ACTIVE');
});

test('a full library never drops the active plan: plans from here go first, then the oldest (audit 4)', () => {
    let t = 1_000_000;
    Date.now = () => (t += 60_000);
    const here = n => raw(50 + n, {meta: {...(base.meta ?? {}), from_here: {kind: 'route'}}});
    for (let n = 0; n < 10; n++) {
        store.savePlan(`P${String(n).padStart(5, '0')}`, raw(n), {activate: false});
    }
    store.setActive('P00000');                       // chosen by hand: the oldest of the ten
    store.savePlan('NEWPLN', raw(99), {activate: false, shelf: true});
    assert.equal(store.listPlans().length, 10);
    assert.ok(store.getActivePlanRaw(), 'the active plan is still there');
    assert.equal(store.getPlanEntry('P00001'), null, 'the oldest of the others went instead');

    // Plans from here go before older plans.
    store.savePlan('HERE01', here(1), {activate: false, shelf: true});
    assert.ok(store.getPlanEntry('NEWPLN'), 'the older plan stays');
    assert.equal(store.getPlanEntry('P00002'), null, 'one more plan: the oldest goes');
    store.savePlan('NEXT01', raw(98), {activate: false});
    assert.equal(store.getPlanEntry('HERE01'), null, 'the plan from here is the one to go now');
    assert.ok(store.getPlanEntry('P00003'), 'though the older plans are older');
    // Saving the active plan under a new code (it is the replacement) keeps both rules.
    store.setActive('NEXT01');
    for (let n = 0; n < 12; n++) {
        store.savePlan(`LATE${n}`, raw(200 + n), {activate: false});
        assert.ok(store.getPlanEntry('NEXT01'), `still there after ${n + 1} more`);
    }
});

test('a plan removed by hand does not come back while the shelf lists it as it was; a republished plan does (minor)', async () => {
    const entry = (code, extra = {}) => ({code, route_id: '1001', laps: 1, source: 'planner', event: null, created_at: '2026-11-26 10:00:00', published_at: '2026-11-26T10:00:00+00:00', expires_at: '2026-12-03T10:00:00Z', fetched_at: null, ...extra});
    const loaded = [];
    const sync = async plans => syncOnce({
        fetchFn: listing(plans), token: 't',
        library: {...shelfLibrary(), dismissed: p => store.isDismissed(p.code, p.published_at ?? p.created_at ?? null)},
        loadPlan: async code => { loaded.push(code); return {raw: raw(1), meta: {}}; },
    });
    await sync([entry('AAAAAA')]);
    assert.deepEqual(loaded, ['AAAAAA']);
    store.removePlan('AAAAAA');                           // the Remove button in the settings
    assert.equal(store.getPlanEntry('AAAAAA'), null);
    // The listing changes (another plan arrives); the removed one is still in it, as it was.
    const r = await sync([entry('BBBBBB', {route_id: '1002', published_at: '2026-11-26T11:00:00+00:00'}), entry('AAAAAA', {fetched_at: null})]);
    assert.deepEqual(r.added, ['BBBBBB'], 'only the new plan');
    assert.equal(store.getPlanEntry('AAAAAA'), null);
    // The planner republishes it: it comes back.
    const again = await sync([entry('AAAAAA', {published_at: '2026-11-26T12:00:00+00:00'})]);
    assert.deepEqual(again.added, ['AAAAAA']);
    assert.ok(store.getPlanEntry('AAAAAA'));
});
