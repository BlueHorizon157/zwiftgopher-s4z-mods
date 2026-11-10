// The rivals strip's track and sides, on the clock (engine/field-model.mjs trackScale and
// rivalsOf): the range (30 s, 1, 2 or 5 minutes, or the whole field; one minute by default, and
// the retired 'play' reads as one minute), the riders it shows, and the nearest each side.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trackScale, rivalsOf, trackRangeOf, drift, DEFAULT_TRACK_RANGE, TRACK_RANGES} from '../pages/src/engine/field-model.mjs';

// A row as rows() gives it: gapS on the clock (+ ahead of you); the pace, + when you gain on them.
const r = (id, gapS, paceSPerMin = 0, extra = {}) => ({
    id, name: `Rider ${id}`, isHome: false, comparable: true, stale: false, gapS, clockS: gapS,
    paceSPerMin, paceSpanS: 240, trend: null, gainSPerMin: null, finished: false, finishRaceS: null, ...extra,
});
const home = {id: 'home', name: 'You', isHome: true, comparable: true, stale: false, gapS: 0, clockS: 0, finished: false};

test('the default track is one minute each way, and the retired play range reads as one minute', () => {
    assert.equal(DEFAULT_TRACK_RANGE, '60');
    assert.deepEqual(TRACK_RANGES, ['30', '60', '120', '300', 'field']);
    assert.equal(trackRangeOf('play'), '60');
    assert.equal(trackRangeOf('nonsense'), '60');
    assert.equal(trackRangeOf('300'), '300');
    const all = [r('near', 20), r('far-ahead', 240), r('far-behind', -400), r('close-behind', -35)];
    const t = trackScale(all, {});
    assert.equal(t.rangeS, 60);
    assert.deepEqual(t.shown.map(x => x.id), ['near', 'close-behind']);
    assert.equal(t.hiddenAhead, 1);
    assert.equal(t.hiddenBehind, 1);
});

test('fixed ranges: 30 s, 2 min, 5 min, and the whole field', () => {
    const all = [r('a', 25), r('b', -70), r('c', 290)];
    assert.equal(trackScale(all, {mode: '30'}).rangeS, 30);
    assert.deepEqual(trackScale(all, {mode: '30'}).shown.map(x => x.id), ['a']);
    assert.equal(trackScale(all, {mode: '120'}).hiddenAhead, 1);
    assert.equal(trackScale(all, {mode: '120'}).hiddenBehind, 0);
    assert.equal(trackScale(all, {mode: '300'}).shown.length, 3);
    const field = trackScale(all, {mode: 'field'});
    assert.equal(field.rangeS, 300, 'wide enough for everyone, in the steps');
    assert.equal(field.shown.length, 3);
    assert.equal(trackScale([], {mode: 'field'}).rangeS, 15);
});

test('the whole field goes past ten minutes when someone is that far back', () => {
    const t = trackScale([r('a', 25), r('b', -1230)], {mode: 'field'});
    assert.equal(t.rangeS, 1260, 'the next whole minute past the furthest rider');
    assert.equal(t.shown.length, 2);
});

test('the sides: the nearest each side on the clock, nearest first; the others left out', () => {
    const list = [home, r('a', 12), r('b', 3), r('c', 40), r('d', -2), r('e', -9), r('f', -30)];
    const rv = rivalsOf(list, {each: 2});
    assert.deepEqual(rv.ahead.map(x => x.id), ['b', 'a']);
    assert.deepEqual(rv.behind.map(x => x.id), ['d', 'e']);
    assert.equal(rv.all.length, 6);
    assert.equal(rv.home.id, 'home');
});

test('the sides leave out riders you cannot compare yet, and riders not seen lately', () => {
    const list = [home, r('a', 12), {...r('b', 5), comparable: false, reason: 'not started'}, {...r('c', -3), stale: true, comparable: false}];
    const rv = rivalsOf(list, {each: 2});
    assert.deepEqual(rv.ahead.map(x => x.id), ['a']);
    assert.deepEqual(rv.behind.map(x => x.id), []);
});

test('a finished rider stays on the track and the sides, by their gap', () => {
    const list = [home, r('a', 12), r('f', -90, null, {finished: true, finishRaceS: 1900})];
    const rv = rivalsOf(list, {each: 2});
    assert.deepEqual(rv.behind.map(x => x.id), ['f']);
    assert.equal(trackScale(rv.all, {mode: '60'}).shown.length, 1, 'off the one-minute track');
    assert.equal(trackScale(rv.all, {mode: '120'}).shown.length, 2);
});

test('the trend for the sides: the sustained pace when there is enough of it, else the last minute', () => {
    assert.deepEqual(drift({paceSPerMin: 1.2, trend: 'losing', gainSPerMin: -3}), {sPerMin: 1.2, word: 'gaining', sustained: true});
    assert.equal(drift({paceSPerMin: 0.1}).word, 'holding');
    assert.deepEqual(drift({paceSPerMin: null, trend: 'losing', gainSPerMin: -2}), {sPerMin: -2, word: 'losing', sustained: false});
    assert.equal(drift({paceSPerMin: null, trend: null}), null);
});
