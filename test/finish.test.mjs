// The finish cell (views/dom.mjs finishFigure): time to go by default, the predicted finish
// time by the setting, the plan's time before the start, the rider's time after the finish.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finishFigure, fmtTime, deltaWords} from '../pages/src/views/dom.mjs';

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
