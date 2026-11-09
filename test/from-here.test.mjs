// Plan from here (README "Plan from here"): what it would plan from a tick, the ride's power
// for the planner, the bike, when the HUD offers it, and the engine riding a plan from here:
// at once from its anchor, W' from where the planner said, and spent once the rider leaves.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hereTarget, powerHistory, chooseBike, hereOffered, hereWords, bikeWords, MAX_HISTORY_S, PAUSED, hereCard, HERE_STRATEGY_DEFAULT} from '../pages/src/views/from-here.mjs';
import {createEngine} from '../pages/src/engine/engine.mjs';
import {normalisePlan} from '../pages/src/engine/plan.mjs';

const ROUTE = '3395698268';
const tick = ({distance = 50000, worldTime = 1.7e12, routeId = ROUTE, sg = null, eventDistance = 0, speed = 43, power = 280, ...top} = {}) => ({
    athleteId: 1, self: true,
    state: {distance, worldTime, routeId, speed, power, eventSubgroupId: sg, eventDistance, time: 0},
    ...top,
});

// ---- the target ----

test('a free ride on a route: to the end of the lap, from Sauce\'s route remaining', () => {
    const t = hereTarget(tick({remaining: 8200.4, remainingMetric: 'distance', remainingType: 'route', remainingEnd: 11000}));
    assert.equal(t.ok, true);
    assert.equal(t.kind, 'route');
    assert.equal(t.routeId, ROUTE);
    assert.equal(t.remainingM, 8200);
    assert.deepEqual(t.anchor, {rideM: 50000, worldMs: 1.7e12, subgroupId: null, routeId: ROUTE});
    assert.equal(t.laps, null);
});

test('a free ride: older Sauce with routeEnd and routeDistance only', () => {
    const tk = tick();
    tk.state.routeEnd = 11000;
    tk.state.routeDistance = 4000;
    const t = hereTarget(tk);
    assert.equal(t.ok, true);
    assert.equal(t.remainingM, 7000);
});

test('a free ride with no route has nothing to plan to', () => {
    const t = hereTarget(tick({routeId: null}));
    assert.equal(t.ok, false);
    assert.match(t.why, /Pick a route/);
});

test('a race under way: the rest of it, with the event\'s route, laps, length and rules', () => {
    const info = {subgroupId: '777', eventId: '55', routeId: 3395698268, laps: 2, distanceM: null, name: 'Crit City Race', startMs: 1.6999e12, rules: ['NO_POWERUPS'], kind: 'group'};
    const t = hereTarget(tick({sg: 777, eventDistance: 12000, remaining: 9000, remainingMetric: 'distance', remainingType: 'event'}), info);
    assert.equal(t.ok, true);
    assert.equal(t.kind, 'event');
    assert.equal(t.routeId, ROUTE);
    assert.equal(t.laps, 2);
    assert.equal(t.remainingM, 9000);
    assert.equal(t.name, 'Crit City Race');
    assert.deepEqual(t.rules, ['NO_POWERUPS']);
    assert.equal(t.anchor.subgroupId, '777');
});

test('in the pen, a race ridden for a time, or nearly done: no plan from here', () => {
    assert.match(hereTarget(tick({sg: 777, eventDistance: 0, remaining: 20000, remainingMetric: 'distance'})).why, /not started/);
    assert.match(hereTarget(tick({sg: 777, eventDistance: 5000, remaining: 900, remainingMetric: 'time'})).why, /for a time/);
    assert.match(hereTarget(tick({remaining: 300, remainingMetric: 'distance', remainingType: 'route'})).why, /Under 500 m/);
    assert.match(hereTarget(null).why, /Waiting/);
});

// ---- the ride's power ----

test('power at 1 Hz: paused seconds, short gaps held, long gaps paused', () => {
    const time = [0, 1, 2, 3, 5, 6, 20, 21];          // a 2 s gap (held), a 14 s gap (paused)
    const power = [200, 210, 220, 230, 240, 250, 260, 270];
    const active = [true, true, false, true, true, true, true, true];
    const h = powerHistory({time, power, active});
    assert.deepEqual(h.power.slice(0, 7), [200, 210, PAUSED, 230, 240, 240, 250]);
    assert.equal(h.power.length, 22);
    assert.deepEqual(h.power.slice(7, 20), Array(13).fill(PAUSED));
    assert.deepEqual(h.power.slice(20), [260, 270]);
    assert.equal(h.raceFromS, 0);
});

test('the race starts where the distance stream was eventDistance short of now; draft counted in it', () => {
    const n = 600;
    const time = Array.from({length: n}, (_, i) => i);
    const power = Array(n).fill(250);
    const distance = Array.from({length: n}, (_, i) => 1000 + i * 10);     // 10 m/s
    const draft = Array.from({length: n}, (_, i) => (i < 100 || i > 590 ? 30 : 0));
    const h = powerHistory({time, power, distance, draft}, {eventDistanceM: 3000});
    // now = 1000 + 599*10 = 6990; race began at 3990 → sample 299
    assert.equal(h.raceFromS, 299);
    assert.equal(h.raceS, 301);
    assert.equal(h.draftS, 9, 'only the draft in the race');
    const free = powerHistory({time, power, distance, draft});
    assert.equal(free.raceFromS, 0);
    assert.equal(free.draftS, 109, 'outside a race, the whole ride');
});

test('only the newest six hours go, the race start moved with them', () => {
    const n = MAX_HISTORY_S + 100;
    const time = Array.from({length: n}, (_, i) => i);
    const power = Array(n).fill(200);
    const distance = Array.from({length: n}, (_, i) => i * 10);
    const h = powerHistory({time, power, distance}, {eventDistanceM: 10 * 1000});
    assert.equal(h.power.length, MAX_HISTORY_S);
    assert.equal(h.raceFromS, n - 1 - 1000 - 100);
    assert.deepEqual(powerHistory(null), {power: [], raceFromS: 0, draftS: 0, raceS: 0});
});

// ---- the bike ----

test('the bike: road unless something says TT', () => {
    const race = {kind: 'event', rules: [], eventKind: 'group'};
    assert.deepEqual(chooseBike({setting: 'tt', target: race, draftS: 500}), {bike: 'tt', reason: 'setting'});
    assert.deepEqual(chooseBike({setting: 'road', target: {kind: 'event', rules: ['NO_DRAFTING']}}), {bike: 'road', reason: 'setting'});
    assert.deepEqual(chooseBike({target: {kind: 'event', rules: ['NO_DRAFTING']}}), {bike: 'tt', reason: 'no-draft event'});
    assert.deepEqual(chooseBike({target: {kind: 'event', rules: [], eventKind: 'tt'}}), {bike: 'tt', reason: 'no-draft event'});
    assert.deepEqual(chooseBike({target: race, draftS: 40, raceS: 1200}), {bike: 'road', reason: 'drafted'});
    assert.deepEqual(chooseBike({target: race, draftS: 0, raceS: 1200}), {bike: 'tt', reason: 'no draft in the race'});
    assert.deepEqual(chooseBike({target: race, draftS: 0, raceS: 60}), {bike: 'road', reason: 'default'}, 'too early in a race to tell');
    assert.deepEqual(chooseBike({target: {kind: 'route'}, draftS: 0, raceS: 3600}), {bike: 'road', reason: 'default'}, 'a solo free ride says nothing');
    assert.equal(bikeWords({bike: 'tt', reason: 'no draft in the race'}), 'a TT bike (no draft all race)');
});

// ---- the offer ----

test('offered when riding with no plan for the ride, linked, on the rider\'s own ride', () => {
    const target = {ok: true};
    assert.equal(hereOffered({linked: true, status: 'idle', plan: null, target}), true);
    assert.equal(hereOffered({linked: false, status: 'idle', plan: null, target}), false);
    assert.equal(hereOffered({linked: true, spectating: true, status: 'idle', target}), false);
    assert.equal(hereOffered({linked: true, status: 'idle', plan: null, target: {ok: false}}), false);
    assert.equal(hereOffered({linked: true, status: 'idle', plan: {code: 'A'}, target}), true, 'a plan for another ride');
    assert.equal(hereOffered({linked: true, status: 'racing', plan: {code: 'A'}, target}), false, 'a plan for this race: its strategy or Clear plan, not a new plan over it');
    assert.equal(hereOffered({linked: true, status: 'racing', plan: {code: 'H', fromHere: {}}, target}), true, 'a plan from here running: made again from here');
    assert.equal(hereOffered({linked: true, status: 'racing', plan: {code: 'A'}, mismatchM: 6000, target}), true, 'a plan for another distance');
    assert.equal(hereOffered({linked: true, status: 'finished', plan: {code: 'H', fromHere: {}}, target}), true, 'the lap after a plan from here');
    assert.equal(hereOffered({linked: true, status: 'finished', plan: {code: 'A'}, target}), false);
    assert.equal(hereOffered({linked: true, status: 'armed', plan: {code: 'A'}, target}), false);
});

test('the banner words', () => {
    assert.equal(hereWords({bike: 'road', cpFactor: 1}), 'from here · road bike');
    assert.equal(hereWords({bike: 'tt', cpFactor: 0.95}), 'from here · TT bike · tired legs');
    assert.equal(hereWords({bike: 'road', cpFactor: 0.85}), 'from here · road bike · very tired legs');
    assert.equal(hereWords({bike: 'road', cpFactor: 0.8, overBudget: true}), 'from here · road bike · past what you can hold');
});

// ---- the engine ----

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
function herePlan({kind = 'route', rideM = 50000, worldMs = 1.7e12, subgroupId = null, fraction = 0.4} = {}) {
    const raw = structuredClone(fixture);
    raw.meta.from_here = {kind, remaining_m: 10710, start_wbal_fraction: fraction, cp_factor: 0.95, bike: 'road', bike_reason: 'drafted',
        anchor: {ride_m: rideM, world_ms: worldMs, subgroup_id: subgroupId, route_id: kind === 'route' ? ROUTE : null}};
    return raw;
}

test('the plan carries its anchor and its W\' at the start; without an anchor it is an ordinary plan', () => {
    const p = normalisePlan(herePlan(), {code: 'HERE01'});
    assert.equal(p.fromHere.kind, 'route');
    assert.equal(p.fromHere.rideM, 50000);
    assert.equal(p.fromHere.startWbalJ, 0.4 * p.wPrimeJ);
    assert.equal(p.fromHere.cpFactor, 0.95);
    const raw = herePlan();
    delete raw.meta.from_here.anchor;
    assert.equal(normalisePlan(raw).fromHere, null);
    assert.equal(normalisePlan(fixture).fromHere, null);
});

function ride({plan, from = 50000, worldMs = 1.7e12, seconds, speedMs = 12, routeId = ROUTE, sg = null, eventDistance0 = 5000, engine = createEngine({prefs: {smoothingSec: 0}}), planAtS = null}) {
    const seen = [];
    for (let s = 0; s <= seconds; s++) {
        if (planAtS === s) {
            engine.event('plan', {plan, code: 'HERE01'}, worldMs + s * 1000);
        }
        engine.tick(tick({distance: from + s * speedMs, worldTime: worldMs + s * 1000, routeId, sg, eventDistance: sg ? eventDistance0 + s * speedMs : 0}), worldMs + s * 1000);
        seen.push(engine.view().status);
    }
    return {engine, statuses: [...new Set(seen)]};
}

test('a plan from here races at once, measured from where and when it was asked for', () => {
    // Asked for at ride metre 50000; the plan arrives 8 s (96 m) later.
    const {engine, statuses} = ride({plan: herePlan(), seconds: 30, planAtS: 8});
    assert.deepEqual(statuses, ['idle', 'racing']);
    const v = engine.view();
    assert.equal(v.race.signal, 'here');
    assert.equal(v.race.planM, 30 * 12, 'plan metres from the anchor');
    assert.ok(Math.abs(v.race.elapsedS - 30) < 0.01, `clock from the anchor: ${v.race.elapsedS}`);
    assert.equal(v.race.finishM, 10710);
    assert.equal(v.event.mismatchM, null);
    assert.equal(v.event.lineM, 0);
    assert.equal(v.plan.fromHere.bike, 'road');
    assert.equal(v.plan.fromHere.spent, false);
});

test('W\' starts where the planner said, not full', () => {
    const plan = herePlan({fraction: 0.4});
    const engine = createEngine({prefs: {smoothingSec: 0}});
    engine.event('plan', {plan, code: 'HERE01'});
    engine.tick(tick({distance: 50050, worldTime: 1.7e12 + 4000, power: 271.9}), 1.7e12 + 4000);
    const v = engine.view();
    assert.equal(v.status, 'racing');
    assert.ok(Math.abs(v.wbal.pct - 40) < 0.5, `W' ${v.wbal.pct} %`);
});

test('finished at the plan\'s end; leaving the route then spends it, and it never arms again', () => {
    const plan = herePlan();
    const {engine, statuses} = ride({plan, seconds: Math.ceil(10710 / 12) + 2, planAtS: 0});
    assert.deepEqual(statuses, ['racing', 'finished']);
    // Off the route: spent, idle.
    engine.tick(tick({distance: 70000, worldTime: 1.7e12 + 2e6, routeId: '999'}), 1.7e12 + 2e6);
    assert.equal(engine.view().status, 'idle');
    assert.equal(engine.state.hereSpent, true);
    // Back on the route, or into an event: it stays idle.
    engine.tick(tick({distance: 70100, worldTime: 1.7e12 + 2.01e6}), 1.7e12 + 2.01e6);
    engine.tick(tick({distance: 70200, worldTime: 1.7e12 + 2.02e6, sg: 12, eventDistance: 10}), 1.7e12 + 2.02e6);
    assert.equal(engine.view().status, 'idle');
    assert.equal(engine.view().plan.fromHere.spent, true);
});

test('in a race: racing while in that subgroup, spent on leaving it', () => {
    const plan = herePlan({kind: 'event', subgroupId: '777'});
    const {engine, statuses} = ride({plan, seconds: 20, planAtS: 3, sg: 777});
    assert.deepEqual(statuses, ['idle', 'racing']);
    assert.equal(engine.view().race.planM, 20 * 12);
    engine.tick(tick({distance: 51000, worldTime: 1.7e12 + 60000, sg: null}), 1.7e12 + 60000);
    assert.equal(engine.view().status, 'idle');
    assert.equal(engine.state.hereSpent, true);
});

test('a plan from here made in another subgroup never races this one', () => {
    const plan = herePlan({kind: 'event', subgroupId: '777'});
    const {statuses} = ride({plan, seconds: 5, planAtS: 0, sg: 888});
    assert.deepEqual(statuses, ['idle']);
});

test('a new plan after a spent one starts afresh', () => {
    const {engine} = ride({plan: herePlan(), seconds: 3, planAtS: 0});
    engine.tick(tick({distance: 60000, worldTime: 1.7e12 + 1e6, routeId: '999'}), 1.7e12 + 1e6);
    assert.equal(engine.state.hereSpent, true);
    // Back on a route, the rider asks again: the new plan is made where they are.
    engine.tick(tick({distance: 60100, worldTime: 1.7e12 + 1.01e6, routeId: ROUTE}), 1.7e12 + 1.01e6);
    assert.equal(engine.view().status, 'idle', 'the spent plan stays put');
    engine.event('plan', {plan: herePlan({rideM: 60100, worldMs: 1.7e12 + 1.01e6}), code: 'HERE02'}, 1.7e12 + 1.01e6);
    assert.equal(engine.state.hereSpent, false);
    engine.tick(tick({distance: 60200, worldTime: 1.7e12 + 1.02e6, routeId: ROUTE}), 1.7e12 + 1.02e6);
    assert.equal(engine.view().status, 'racing');
    assert.equal(engine.view().race.planM, 100);
});

test('a plan from here starts on Balanced unless the setting says otherwise', () => {
    const file = JSON.parse(readFileSync(new URL('./fixtures/plans/flat.fit.optimise.json', import.meta.url), 'utf8'));
    assert.equal(HERE_STRATEGY_DEFAULT, 'balanced');
    assert.equal(hereCard(file), 'balanced', 'the default');
    assert.equal(hereCard(file, 'safe_finish'), 'safe_finish');
    assert.equal(hereCard(file, 'fastest'), null, 'Fastest is the plan as shared: no card');
    assert.equal(hereCard(file, 'nonsense'), 'balanced', 'an unknown setting: the default');
    assert.equal(hereCard({...file, cards: []}), null, 'no cards: the plan as shared');
});
