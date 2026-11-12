// The finish cell (views/dom.mjs finishFigure): time to go by default, the predicted finish
// time by the setting, the plan's time before the start, the rider's time after the finish.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finishFigure, planTimeS, fmtTime, deltaWords} from '../pages/src/views/dom.mjs';

const plan = {timeS: 900};
const racing = {status: 'racing', plan, race: {running: true, elapsedS: 300, totalS: 905, remainingS: 605, deltaS: 5, planTimeFromStartS: 900}};

test('while racing: the time to go by default, the predicted finish by the setting', () => {
    assert.deepEqual(finishFigure(racing), {label: 'to go', seconds: 605});
    assert.deepEqual(finishFigure(racing, 'remaining'), {label: 'to go', seconds: 605});
    assert.deepEqual(finishFigure(racing, 'finish'), {label: 'finish', seconds: 905});
    assert.equal(fmtTime(finishFigure(racing).seconds), '10:05');
    assert.equal(deltaWords(racing.race.deltaS), deltaWords(5), 'the delta from the plan is the same either way');
});

test('the time to go falls back to the prediction less the clock', () => {
    const v = {...racing, race: {...racing.race, remainingS: null}};
    assert.deepEqual(finishFigure(v), {label: 'to go', seconds: 605});
});

test('before the start the plan time, after the finish the rider\'s time, without a plan nothing', () => {
    const armed = {status: 'armed', plan, race: {running: false, planTimeFromStartS: 880}};
    assert.deepEqual(finishFigure(armed), {label: 'plan', seconds: 880});
    assert.deepEqual(finishFigure(armed, 'finish'), {label: 'plan', seconds: 880});
    assert.deepEqual(finishFigure({status: 'armed', plan, race: {running: false}}), {label: 'plan', seconds: 900});
    const done = {status: 'finished', plan, race: {running: false, elapsedS: 912}};
    assert.deepEqual(finishFigure(done), {label: 'finished', seconds: 912});
    assert.deepEqual(finishFigure(done, 'finish'), {label: 'finished', seconds: 912});
    assert.equal(finishFigure({status: 'idle', plan: null, race: {}}).seconds, null);
});

test('a mass start: the finish time and the rider\'s time count from the gun; the time to go and the plan do not', () => {
    // 19 s from the gun to the timing line, where the plan and its clock start.
    const mass = {...racing, race: {...racing.race, gunToLineS: 19, officialElapsedS: 319, officialTotalS: 924}};
    assert.deepEqual(finishFigure(mass), {label: 'to go', seconds: 605});
    assert.deepEqual(finishFigure(mass, 'finish'), {label: 'finish', seconds: 924});
    const done = {status: 'finished', plan, race: {running: false, elapsedS: 912, gunToLineS: 19, officialElapsedS: 931}};
    assert.deepEqual(finishFigure(done), {label: 'finished', seconds: 931});
    assert.deepEqual(finishFigure(done, 'finish'), {label: 'finished', seconds: 931});
    const armed = {status: 'armed', plan, race: {running: false, planTimeFromStartS: 880, gunToLineS: null, officialElapsedS: null, officialTotalS: null}};
    assert.deepEqual(finishFigure(armed), {label: 'plan', seconds: 880});
    // No gun known (a TT, or a mass start Sauce gave no start time for): the line's times.
    const noGun = {...racing, race: {...racing.race, gunToLineS: null, officialElapsedS: null, officialTotalS: null}};
    assert.deepEqual(finishFigure(noGun, 'finish'), {label: 'finish', seconds: 905});
    assert.deepEqual(finishFigure({status: 'finished', plan, race: {running: false, elapsedS: 912, officialElapsedS: null}}), {label: 'finished', seconds: 912});
});

test('the plan\'s time beside the finish is on the same clock: in a mass start the gun\'s seconds are added once known', () => {
    assert.equal(planTimeS(racing), 900);
    assert.equal(planTimeS({status: 'armed', plan, race: {running: false}}), 900, 'before the start the plan\'s own time');
    assert.equal(planTimeS({status: 'armed', plan, race: {running: false, planTimeFromStartS: 880, gunToLineS: null}}), 880);
    // 19 s from the gun to the line: the rider's 931 s less the plan's 919 s is the 12 s behind shown.
    const done = {status: 'finished', plan, race: {running: false, elapsedS: 912, deltaS: 12, planTimeFromStartS: 900, gunToLineS: 19, officialElapsedS: 931}};
    assert.equal(planTimeS(done), 919);
    assert.equal(finishFigure(done).seconds - planTimeS(done), done.race.deltaS);
    assert.equal(planTimeS({status: 'idle', plan: null, race: {}}), null);
});
