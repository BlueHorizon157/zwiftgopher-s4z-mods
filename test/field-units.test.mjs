import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fmtGap, fmtRate, boundariesOf, shortName, playOf, playCall, playWords} from '../pages/src/views/field-units.mjs';

test('fmtGap rounds before choosing the format, so no value outgrows its column', () => {
    assert.equal(fmtGap(4.24), '4.2 s');
    assert.equal(fmtGap(-9.94), '9.9 s');
    assert.equal(fmtGap(9.96), '10 s');          // was "10.0 s", too wide for the gap column
    assert.equal(fmtGap(42.4), '42 s');
    assert.equal(fmtGap(59.6), '1:00');          // was "60 s"
    assert.equal(fmtGap(72), '1:12');
    assert.equal(fmtGap(119.6), '2:00');         // was "1:60"
    assert.equal(fmtGap(NaN), '');
});

test('boundariesOf turns plan metres into event metres through the timing line', () => {
    const plan = {intervals: [{endM: 520}, {endM: 734}, {endM: 9275}], routeMPerGameM: 0.99856};
    // A plan whose metre 0 is the line (the measured line): event metres = plan metres / k.
    const atLine = boundariesOf({event: {lineM: 0}}, plan);
    assert.deepEqual(atLine.map(m => Math.round(m)), [0, 521, 735, 9288]);
    // A plan on the old axis, the course matched 160 m in: the first end is 360 m after the line.
    const old = boundariesOf({event: {lineM: 160}}, plan);
    assert.deepEqual(old.map(m => Math.round(m)), [0, 361, 575, 9128]);
    // Interval ends at or before the line are not sectors.
    assert.deepEqual(boundariesOf({event: {lineM: 600}}, {intervals: [{endM: 520}, {endM: 734}]}), [0, 134]);
    // The rider's manual offset comes out of the plan metre first.
    assert.deepEqual(boundariesOf({event: {lineM: 0}, controls: {offsetM: 20}}, {intervals: [{endM: 520}]}), [0, 500]);
    // Not this route, or no plan: no sectors.
    assert.equal(boundariesOf({event: {routeMatches: false}}, plan), null);
    assert.equal(boundariesOf({}, null), null);
});

test('shortName keeps the first initial and the rest', () => {
    assert.equal(shortName('Rider 14'), 'R. 14');
    assert.equal(shortName('Solo'), 'Solo');
});

test('fmtRate keeps one decimal under 10 s a minute and whole seconds from there', () => {
    assert.equal(fmtRate(0.6), '0.6 s');
    assert.equal(fmtRate(-2.44), '2.4 s');
    assert.equal(fmtRate(9.96), '10 s');           // "+14.3 s" was cut off in the field's column
    assert.equal(fmtRate(14.3), '14 s');
    assert.equal(fmtRate(NaN), '');
});

test('playOf colours only the riders in play: targets ahead, threats behind', () => {
    // Ahead now: you beat them at this pace, or finish close behind them: a target.
    assert.equal(playOf({state: 'beat'}), 'target');
    assert.equal(playOf({state: 'reach'}), 'target');
    // Behind now: they beat you at this pace, or finish close behind you: a threat.
    assert.equal(playOf({state: 'beaten'}), 'threat');
    assert.equal(playOf({state: 'pressure'}), 'threat');
    // Far behind and falling away, or far ahead and pulling away: not in play.
    assert.equal(playOf({state: 'clear'}), null);
    assert.equal(playOf(null), null);
});

test('playWords says how it ends at this pace and what that makes the rider', () => {
    assert.equal(playWords({state: 'beat', finishGapS: -4.2}), 'at this pace you finish 4.2 s ahead of them: a target');
    assert.equal(playWords({state: 'reach', finishGapS: 6}), 'at this pace they finish 6.0 s ahead of you: a target');
    assert.equal(playWords({state: 'pressure', finishGapS: -3}, {faint: true}), 'at this pace you finish 3.0 s ahead of them: a threat (early: the call settles 20 minutes in)');
    assert.equal(playWords({state: 'beaten', finishGapS: 12, finished: true}), 'against their finish time, they finish 12 s ahead of you: a threat');
    assert.equal(playWords({state: 'clear', finishGapS: 40}), '');
});

test('playCall waits for a rider\'s pace, and is faint until the outlook settles', () => {
    // No pace yet: the outlook carries the gap as it stands, so no call (it would call riders you lose on targets).
    assert.equal(playCall({state: 'reach', paceSPerMin: null}, {settled: true}), null);
    // Paced: called; faint before the outlook settles (20 minutes in, or 5 to go).
    assert.deepEqual(playCall({state: 'beat', paceSPerMin: 2.3}, {settled: false}), {play: 'target', faint: true});
    assert.deepEqual(playCall({state: 'beaten', paceSPerMin: -1.2}, {settled: true}), {play: 'threat', faint: false});
    // A finished rider has a known time: no pace needed.
    assert.deepEqual(playCall({state: 'beaten', finished: true, paceSPerMin: null}, {settled: true}), {play: 'threat', faint: false});
    // Not in play: no call.
    assert.equal(playCall({state: 'clear', paceSPerMin: 3}, {settled: true}), null);
});
