// The rivals track's scale (engine/field-model.mjs trackScale): ±1 min by default, widened for the
// riders in play (caught, or catching you, before the finish at the current trend), fixed
// ranges, and the whole field as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackScale, meetInS, playSet} from '../pages/src/engine/field-model.mjs';

// roadS > 0: ahead on the road. paceSPerMin > 0: you gain time on them, over the last minutes.
const r = (id, roadS, paceSPerMin) => ({id, roadS, paceSPerMin});

test('when two riders meet on the road at the current trend', () => {
    assert.equal(meetInS(r('a', 30, 6)), 300, 'ahead by 30 s, you gain 6 s a minute: caught in 5 min');
    assert.equal(meetInS(r('b', -45, -3)), 900, 'behind by 45 s, gaining 3 s a minute on you: 15 min');
    assert.equal(meetInS(r('c', 30, -2)), null, 'ahead and pulling away');
    assert.equal(meetInS(r('d', -20, 4)), null, 'behind and dropping back');
    assert.equal(meetInS(r('e', 10, 0)), null);
    assert.equal(meetInS(r('f', 10, null)), null, 'no pace yet (under 90 s of shared history)');
    assert.equal(meetInS(r('g', 5, 0.2)), null, 'closing under 0.3 s a minute is no prediction');
    assert.equal(meetInS({id: 'h', roadS: 20, gainSPerMin: 30, paceSPerMin: null}), null, 'a fast last minute alone predicts nothing');
});

test('the default: ±1 min with nobody in play, the far riders counted at the ends', () => {
    const all = [r('near', 20, 0.2), r('far-ahead', 240, -1), r('far-behind', -400, 2), r('close-behind', -35, 0.5)];
    const t = trackScale(all, {remainingS: 600});
    assert.equal(t.rangeS, 60);
    assert.deepEqual(t.shown.map(x => x.id), ['near', 'close-behind']);
    assert.equal(t.hiddenAhead, 1);
    assert.equal(t.hiddenBehind, 1);
    assert.equal(t.inPlay.size, 0);
});

test('a rider you will catch before the finish widens the track to hold them', () => {
    const all = [r('near', 20, 0.2), r('target', 150, 30), r('gone', 500, 10)];
    const t = trackScale(all, {remainingS: 600});
    assert.ok(t.inPlay.has('target'), 'ahead 150 s, closing 30 s a minute: 5 min, inside the 10 left');
    assert.ok(!t.inPlay.has('gone'), 'ahead 500 s at 10 s a minute: 50 min, after the finish');
    assert.equal(t.rangeS, 180, 'the next step up from 150 s');
    assert.deepEqual(t.shown.map(x => x.id), ['near', 'target']);
    assert.equal(t.hiddenAhead, 1);
});

test('a rider who will catch you before the finish is in play too; the time to go decides', () => {
    const chaser = r('chaser', -100, -20);   // 5 min to catch you
    assert.ok(trackScale([chaser], {remainingS: 400}).inPlay.has('chaser'));
    assert.equal(trackScale([chaser], {remainingS: 400}).rangeS, 120);
    assert.ok(!trackScale([chaser], {remainingS: 200}).inPlay.has('chaser'), 'the race ends first');
    assert.equal(trackScale([chaser], {remainingS: 200}).rangeS, 60);
    assert.ok(trackScale([chaser], {remainingS: null}).inPlay.has('chaser'), 'no time to go known: a ten-minute horizon');
});

test('fixed ranges and the whole field', () => {
    const all = [r('a', 25, 0), r('b', -70, 0), r('c', 290, 0)];
    assert.equal(trackScale(all, {mode: '30'}).rangeS, 30);
    assert.deepEqual(trackScale(all, {mode: '30'}).shown.map(x => x.id), ['a']);
    assert.equal(trackScale(all, {mode: '120'}).hiddenAhead, 1);
    const field = trackScale(all, {mode: 'field'});
    assert.equal(field.rangeS, 300, 'wide enough for everyone, as before');
    assert.equal(field.shown.length, 3);
    assert.equal(trackScale([], {mode: 'field'}).rangeS, 15);
});

test('in play is sticky: in when the meeting is inside the time to go, out only 15 % past it', () => {
    const edge = r('edge', 100, 10);   // 10 min to meet
    assert.ok(playSet([edge], {remainingS: 600}).inPlay.has('edge'), 'in: meets at the finish');
    assert.ok(!playSet([edge], {remainingS: 560}).inPlay.has('edge'), 'not in from outside');
    const prev = new Set(['edge']);
    assert.ok(playSet([edge], {remainingS: 560, prev}).inPlay.has('edge'), 'stays in while within 15 %');
    assert.ok(!playSet([edge], {remainingS: 500, prev}).inPlay.has('edge'), 'leaves beyond 15 %');
    const p = playSet([r('ahead', 40, 8), r('behind', -30, -6), r('away', 30, -4)], {remainingS: 600});
    assert.deepEqual([...p.catching], ['ahead']);
    assert.deepEqual([...p.caught], ['behind']);
    assert.ok(!p.inPlay.has('away'));
});

import {createField, ingest, rows} from '../pages/src/engine/field-model.mjs';

// Two riders on a flat road, one row a second as Sauce's `nearby` gives them: you (home,
// watching) and a rival who started 20 s up the road, both at 12 m/s; from 300 s you sprint
// at 14 m/s for 15 s, then ride as before.
function ride(seconds, {sprintFrom = 300, sprintS = 15, homeMs = 12, sprintMs = 14, rivalMs = 12} = {}) {
    const field = createField();
    let homeM = 0;
    let rivalM = 20 * rivalMs;
    const t0 = 1_700_000_000_000;
    for (let t = 0; t <= seconds; t++) {
        const sprinting = t >= sprintFrom && t < sprintFrom + sprintS;
        const entries = [
            {athleteId: 1, watching: true, athlete: {sanitizedFullname: 'You'}, state: {eventSubgroupId: 9, eventDistance: homeM, worldTime: t0 + t * 1000, speed: (sprinting ? sprintMs : homeMs) * 3.6}},
            {athleteId: 2, athlete: {sanitizedFullname: 'Rival'}, state: {eventSubgroupId: 9, eventDistance: rivalM, worldTime: t0 + t * 1000, speed: rivalMs * 3.6}},
        ];
        ingest(field, entries, t0 + t * 1000, {lineM: 0, kind: 'tt'});
        homeM += sprinting ? sprintMs : homeMs;
        rivalM += rivalMs;
    }
    return rows(field, {nowMs: t0 + seconds * 1000, gapMode: 'road'}).find(x => x.id === '2' || x.id === 2);
}

test("a sprint moves the last minute's trend but not the pace: the rival does not come into play", () => {
    const r = ride(330);
    assert.ok(r.roadS > 0, 'the rival is still up the road');
    assert.ok(r.gainSPerMin > 1.5, `the one-minute trend jumps with the sprint (${r.gainSPerMin?.toFixed(2)} s/min)`);
    assert.ok(Math.abs(r.paceSPerMin) < r.gainSPerMin / 2, `the four-minute pace moves far less (${r.paceSPerMin?.toFixed(2)} s/min)`);
    const p = playSet([r], {remainingS: 600});
    assert.ok(!p.inPlay.has(r.id), `not in play: ${p.meetS.get(r.id) == null ? 'no meeting predicted' : `meets in ${p.meetS.get(r.id).toFixed(0)} s`}`);
});

test('a sustained faster pace brings the rival into play with a meeting time near the truth', () => {
    // From 120 s you ride 13 m/s against their 12: you gain about 4.6 s a minute on a 20 s gap.
    const r = ride(330, {sprintFrom: 120, sprintS: 10_000, sprintMs: 13});
    assert.ok(r.paceSPerMin > 3, `pace ${r.paceSPerMin?.toFixed(2)} s/min`);
    const p = playSet([r], {remainingS: 600});
    assert.ok(p.inPlay.has(r.id) && p.catching.has(r.id), 'you catch them before the finish');
    const truth = r.roadS / (1 - 12 / 13);   // seconds until you close the road gap
    assert.ok(Math.abs(p.meetS.get(r.id) - truth) / truth < 0.25, `meets in ${p.meetS.get(r.id).toFixed(0)} s, truth ${truth.toFixed(0)} s`);
});

test('near: in reach ahead and pressure behind when close at the finish, not caught', () => {
    // 10 min to go: close is within 10 s at the finish.
    const p = playSet([
        r('reach', 20, 1.2),        // 20 - 12 = 8 s ahead at the finish
        r('far', 60, 1.2),          // 48 s: not close
        r('press', -12, -0.4),      // closing slowly on you: 8 s behind at the finish
        r('dropped', -3, 1.5),      // you ride away: 18 s behind, not close
        r('steady', -6, 0),         // holding 6 s behind: pressure
        r('caught', 10, 2),         // in play, not near
        r('new', 5, null),          // no pace yet: nothing
    ], {remainingS: 600});
    assert.deepEqual([...p.reach].sort(), ['reach']);
    assert.deepEqual([...p.pressure].sort(), ['press', 'steady']);
    assert.ok(p.inPlay.has('caught') && !p.near.has('caught'));
    assert.ok(Math.abs(p.near.get('reach').finishGapS - 8) < 1e-9);
    assert.ok(Math.abs(p.near.get('reach').needSPerMin - 0.8) < 1e-9, '8 s over 10 min to go');
    // Close shrinks with the time to go (1 s a minute, at least 5 s) and is sticky.
    const late = r('late', 7, 0);
    assert.ok(!playSet([late], {remainingS: 120}).near.has('late'), '7 s with 2 min to go is not close');
    assert.ok(playSet([r('late', 4, 0)], {remainingS: 120}).near.has('late'), '4 s is');
    const prev = playSet([r('edge', 10, 0)], {remainingS: 600});
    assert.ok(prev.near.has('edge'));
    assert.ok(playSet([r('edge', 11.5, 0)], {remainingS: 600, prev}).near.has('edge'), 'stays within 25 %');
    assert.ok(!playSet([r('edge', 11.5, 0)], {remainingS: 600}).near.has('edge'), 'not in from outside');
    // The track widens for near riders as for riders in play.
    assert.equal(trackScale([r('reach', 70, 6.5)], {remainingS: 600}).rangeS, 90);
});
