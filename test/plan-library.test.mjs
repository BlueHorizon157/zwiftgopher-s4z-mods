// One plan per course in the mod's library (pages/src/plan-library.mjs; Dave, 2026-11-12), and
// the plans from the shelf that left it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {courseOf, sameCourse, dropTwins, shelfLeavers} from '../pages/src/plan-library.mjs';

const HILLY = '2737483381';
const raw = (route, meta = {}) => ({schema: 'zg-tt-plan/1', route: {id: HILLY, ...route}, meta});
const entry = (r, extra = {}) => ({raw: r, loadedAt: 1, ...extra});

test('a course is the route with its laps, or with its custom distance; a plan from here has none', () => {
    assert.deepEqual(courseOf(raw({laps: 2})), {routeId: HILLY, distanceM: null, laps: 2});
    assert.deepEqual(courseOf(raw({laps: null})), {routeId: HILLY, distanceM: null, laps: 1}, 'files without laps are one lap');
    assert.deepEqual(courseOf(raw({laps: 1, target_distance_km: 6.1})), {routeId: HILLY, distanceM: 6100, laps: null});
    assert.equal(courseOf(raw({laps: 1}, {from_here: {kind: 'event'}})), null);
    assert.equal(courseOf({route: {}}), null);
    assert.equal(courseOf(null), null);
});

test('the same course: same laps, or a distance within 1 %; laps and a distance are never the same', () => {
    const c = r => courseOf(raw(r));
    assert.equal(sameCourse(c({laps: 1}), c({laps: 1})), true);
    assert.equal(sameCourse(c({laps: 1}), c({laps: 2})), false);
    assert.equal(sameCourse(c({target_distance_km: 6.1}), c({target_distance_km: 6.15})), true);
    assert.equal(sameCourse(c({target_distance_km: 6.1}), c({target_distance_km: 6.5})), false);
    assert.equal(sameCourse(c({target_distance_km: 9.68}), c({laps: 1})), false);
    assert.equal(sameCourse(c({laps: 1}), courseOf({route: {id: '3395698268', laps: 1}})), false, 'another route');
    assert.equal(sameCourse(null, c({laps: 1})), false);
});

test('saving a plan removes every other plan for its course, whatever its code; other courses and plans from here stay', () => {
    const plans = {
        OLD111: entry(raw({laps: 1})),
        OLD222: entry(raw({laps: 1}), {shelf: true}),
        TWO333: entry(raw({laps: 2})),
        KM6444: entry(raw({target_distance_km: 6.1})),
        HERE55: entry(raw({laps: 1}, {from_here: {kind: 'route'}})),
    };
    assert.deepEqual(dropTwins(plans, 'NEW999', raw({laps: 1})).sort(), ['OLD111', 'OLD222']);
    assert.deepEqual(Object.keys(plans).sort(), ['HERE55', 'KM6444', 'TWO333']);
    assert.deepEqual(dropTwins(plans, 'KM6444', raw({target_distance_km: 6.12})), [], 'a plan republished under its own code is not its own twin');
    assert.deepEqual(dropTwins(plans, 'KM7000', raw({target_distance_km: 6.12})), ['KM6444']);
    assert.deepEqual(dropTwins(plans, 'HERE66', raw({laps: 2}, {from_here: {kind: 'route'}})), [], 'a plan from here replaces nothing');
    assert.ok(plans.TWO333);
});

test('the plans from the shelf that it no longer lists leave; a plan loaded by its code stays', () => {
    const plans = {
        AAAAAA: entry(raw({laps: 1}), {shelf: true}),
        BBBBBB: entry(raw({laps: 2}), {shelf: true}),
        CCCCCC: entry(raw({laps: 3}), {shelf: false}),
        LEGACY: entry(raw({laps: 4})),
    };
    assert.deepEqual(shelfLeavers(plans, ['AAAAAA']), ['BBBBBB']);
    assert.deepEqual(shelfLeavers(plans, []), ['AAAAAA', 'BBBBBB'], 'an empty shelf: every shelf plan goes');
    assert.deepEqual(shelfLeavers(plans, ['AAAAAA', 'BBBBBB']), []);
});
