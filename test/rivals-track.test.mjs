// The rivals track's scale (engine/field.mjs trackScale): ±1 min by default, widened for the
// riders in play (caught, or catching you, before the finish at the current trend), fixed
// ranges, and the whole field as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackScale, meetInS} from '../pages/src/engine/field.mjs';

// roadS > 0: ahead on the road. gainSPerMin > 0: you gain time on them.
const r = (id, roadS, gainSPerMin) => ({id, roadS, gainSPerMin});

test('when two riders meet on the road at the current trend', () => {
    assert.equal(meetInS(r('a', 30, 6)), 300, 'ahead by 30 s, you gain 6 s a minute: caught in 5 min');
    assert.equal(meetInS(r('b', -45, -3)), 900, 'behind by 45 s, gaining 3 s a minute on you: 15 min');
    assert.equal(meetInS(r('c', 30, -2)), null, 'ahead and pulling away');
    assert.equal(meetInS(r('d', -20, 4)), null, 'behind and dropping back');
    assert.equal(meetInS(r('e', 10, 0)), null);
    assert.equal(meetInS(r('f', 10, null)), null, 'no trend yet');
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
