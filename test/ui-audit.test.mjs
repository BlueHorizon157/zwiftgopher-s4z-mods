// What the rider reads and presses in the HUD, the interval list and the settings page: the
// helpers behind their words and numbers, and the few rules in the pages and stylesheets that a
// layout depends on. Audit of the windows before 1.0.0 (2026-11-26); the layouts themselves were
// checked in the stand-in at the windows' default sizes (docs of that check: the audit report).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fmtTime, fmtPlanTime, fmtCountdown, fmtWattDelta, fmtDistance, fmtGrade, figureTime, figureText, rideAverage, canLowerBias, MIN_BIAS} from '../pages/src/views/dom.mjs';
import {bannerWords, planPanelHint, mismatchWords, MISMATCH_SHORT, outOfStepWords} from '../pages/src/views/banner-words.mjs';
import {plannerLinkSupport} from '../pages/src/views/link-ping.mjs';
import {fakeFetch} from './helpers/sauce-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// ---- numbers and times ----

test('a plan time is rounded to the second as the planner rounds it, a clock shows the second it has reached', () => {
    // the plan file says 894.7 s and "14:55" (inc/ttt.class.php secondsToMinutes rounds)
    assert.equal(fmtPlanTime(894.7), '14:55');
    assert.equal(fmtTime(894.7), '14:54');
    assert.equal(fmtPlanTime(3599.6), '1:00:00');
    assert.equal(fmtPlanTime(null), '—:—');
    assert.equal(fmtPlanTime(NaN, {dash: '–'}), '–');
});

test('the finish figure rounds a plan time and a predicted finish, and floors the time to go and the finished time', () => {
    assert.equal(figureTime({label: 'plan', seconds: 894.7}), '14:55');
    assert.equal(figureTime({label: 'finish', seconds: 894.7}), '14:55');
    assert.equal(figureTime({label: 'to go', seconds: 894.7}), '14:54');
    assert.equal(figureTime({label: 'finished', seconds: 894.7}), '14:54');
    assert.equal(figureText({label: 'to go', seconds: 722.4}), '12:02 to go');
    assert.equal(figureText({label: 'plan', seconds: 894.7}), 'plan 14:55');
    assert.equal(figureText({label: 'finished', seconds: 887.2}), 'finished 14:47');
    assert.equal(figureText({label: 'to go', seconds: null}), '—:— to go');
});

test('the next change in seconds up to 99, as a clock after', () => {
    assert.equal(fmtCountdown(37.4), '37 s');
    assert.equal(fmtCountdown(99.4), '99 s');
    assert.equal(fmtCountdown(99.6), '1:40');
    assert.equal(fmtCountdown(1680), '28:00');
    assert.equal(fmtCountdown(-3), '0 s');
    assert.equal(fmtCountdown(null), '');
    assert.equal(fmtCountdown(NaN), '');
});

test('a watt difference never reads "-0" or "+0"', () => {
    assert.equal(fmtWattDelta(-0.3), '');
    assert.equal(fmtWattDelta(0.4), '');
    assert.equal(fmtWattDelta(0), '');
    assert.equal(fmtWattDelta(-0.5), '');          // Math.round(-0.5) is -0
    assert.equal(fmtWattDelta(-1.5), '−1');
    assert.equal(fmtWattDelta(0.5), '+1');
    assert.equal(fmtWattDelta(2.6), '+3');
    assert.equal(fmtWattDelta(-2.6), '−3');
    assert.equal(fmtWattDelta(NaN), '');
});

test('a grade of -0.04 reads 0.0%, not -0.0%', () => {
    assert.equal(fmtGrade(-0.04), '0.0%');
    assert.equal(fmtGrade(-0.3), '-0.3%');
    assert.equal(fmtGrade(null), '—%');
});

test('a distance never reads 1000 m, a negative one is 0, a missing one is empty', () => {
    assert.equal(fmtDistance(996), '1.00 km');
    assert.equal(fmtDistance(994), '990 m');
    assert.equal(fmtDistance(1000), '1.00 km');
    assert.equal(fmtDistance(342), '340 m');
    assert.equal(fmtDistance(12345), '12.3 km');
    assert.equal(fmtDistance(8580, true), '8.58 km');
    assert.equal(fmtDistance(996, true), '1.00 km');
    assert.equal(fmtDistance(-40), '0 m');
    assert.equal(fmtDistance(-40, true), '0.00 km');
    assert.equal(fmtDistance(null), '');
    assert.equal(fmtDistance(NaN), '');
});

test('the ride average is over the seconds with a power reading: a dropout is not 0 W', () => {
    // 100 s at 300 W then 20 s with no reading: 300 W, not 250 W
    const stats = [{powerS: 100, elapsedS: 120, workJ: 30000}];
    assert.equal(rideAverage(stats), 300);
    assert.equal(rideAverage([{powerS: 60, workJ: 18000}, {powerS: 60, workJ: 12000}, undefined, {powerS: 0, workJ: 0}]), 250);
    assert.equal(rideAverage([]), null);
    assert.equal(rideAverage(null), null);
    assert.equal(rideAverage([{powerS: 6, workJ: 1800}], 10), null);       // the list waits for 10 s
    assert.equal(rideAverage([{powerS: 12, workJ: 3600}], 10), 300);
});

test('the bias goes down to 1 % and no lower', () => {
    assert.equal(MIN_BIAS, 0.01);
    assert.equal(canLowerBias(1), true);
    assert.equal(canLowerBias(0.02), true);
    assert.equal(canLowerBias(0.01), false);
    assert.equal(canLowerBias(0), false);
    assert.equal(canLowerBias(NaN), false);
});

// ---- the banner and the plan panel ----

const armed = (event, extra = {}) => ({status: 'armed', plan: {routeName: 'Watopia Flat Route', lengthM: 10710}, event: {inEvent: true, ...event}, ...extra});

test('the banner in the strip says the whole sentence, the narrow layouts a short one with the whole in the tooltip', () => {
    const waiting = armed({});
    assert.equal(bannerWords(waiting, {now: 1000}).text, 'ready, waiting for the start');
    const narrow = bannerWords(waiting, {narrow: true, now: 1000});
    assert.equal(narrow.text, 'ready, waiting');
    assert.match(narrow.tip, /clock starts when you cross the timing line/);
    assert.equal(bannerWords(armed({startMs: 31000}), {now: 1000}).text, 'starts in 0:30');
    assert.equal(bannerWords(armed({kind: 'group'}), {narrow: true, now: 1000}).text, 'ready, mass start');
    assert.equal(bannerWords({status: 'armed', plan: {}, event: {inEvent: false}}, {}).text, 'ready');
});

test('no narrow banner string is longer than the dial can show (21 characters) except a name or a rider', () => {
    const lengthMismatch = {mismatchM: 5000, lengthM: 16150};
    const cases = [
        armed({}), armed({startMs: 61000}), armed({kind: 'group'}), armed(lengthMismatch),
        {status: 'racing', plan: {lengthM: 22420, fromHere: {bike: 'road', cpFactor: 0.8}}, event: {inEvent: true}},
        {status: 'racing', plan: {lengthM: 22420}, event: {inEvent: true, ...lengthMismatch}},
        {status: 'racing', plan: {}, event: {inEvent: true}, race: {alignment: {outOfStepM: 429}}},
        {status: 'racing', plan: {}, event: {inEvent: true}, race: {alignment: {unmatched: true}}},
        {status: 'racing', plan: {}, event: {inEvent: true, kind: 'group'}, race: {gunToLineS: 18}},
        {status: 'racing', plan: {}, event: {inEvent: true, kind: 'group'}, race: {}},
        {status: 'finished', plan: {routeName: 'x'}},
    ];
    for (const v of cases) {
        const {text} = bannerWords(v, {narrow: true, now: 1000});
        assert.ok(text.length <= 21, `"${text}" is ${text.length} characters`);
    }
});

test('a plan of the wrong length is told in short on the narrow layouts, with both lengths in the tooltip', () => {
    const v = {status: 'racing', plan: {lengthM: 22420}, event: {inEvent: true, lengthM: 16150, mismatchM: -6270}};
    assert.equal(bannerWords(v, {}).text, 'event 16.15 km, plan 22.42 km');
    const narrow = bannerWords(v, {narrow: true});
    assert.equal(narrow.text, MISMATCH_SHORT);
    assert.match(narrow.tip, /event 16\.15 km, plan 22\.42 km/);
    assert.equal(mismatchWords(v), 'event 16.15 km, plan 22.42 km');
    // in the pen the short form replaces "ready, ..." rather than running past the line
    assert.equal(bannerWords(armed({lengthM: 16150, mismatchM: -6270}), {narrow: true}).text, MISMATCH_SHORT);
    assert.equal(bannerWords(armed({lengthM: 16150, mismatchM: -6270}), {}).text, 'ready, waiting for the start, event 16.15 km, plan 10.71 km');
});

test('a plan from here is "from here" on the narrow layouts, with the bike and the legs in the tooltip', () => {
    const v = {status: 'racing', plan: {fromHere: {bike: 'road', cpFactor: 0.95}}};
    assert.equal(bannerWords(v, {}).text, 'from here · road bike · tired legs');
    const narrow = bannerWords(v, {narrow: true});
    assert.equal(narrow.text, 'from here');
    assert.equal(narrow.tip, 'from here · road bike · tired legs');
});

test('spectating names the rider in the one string the dial can cut with an ellipsis; the strip sets the name apart', () => {
    const v = {status: 'racing', plan: {}, spectating: {name: 'Sam Rider'}};
    assert.deepEqual(bannerWords(v, {}), {text: 'spectating ', name: 'Sam Rider', tip: ''});
    assert.deepEqual(bannerWords(v, {narrow: true}), {text: 'spectating Sam Rider', name: '', tip: ''});
    assert.equal(bannerWords({status: 'racing', spectating: {}}, {narrow: true}).text, 'spectating another rider');
});

test('a plan waiting for its route: the strip keeps the one line, the narrow layouts the status with the route as the name', () => {
    const v = {status: 'idle', plan: {routeName: 'Flat Route'}};
    assert.equal(bannerWords(v, {idleStatus: 'waiting', idleNext: 'Urumaze 19:20 (in 42 min) · plan ready'}).text, 'Flat Route: waiting · next TT Urumaze 19:20 (in 42 min) · plan ready');
    const narrow = bannerWords(v, {narrow: true, idleStatus: 'waiting', idleNext: 'Urumaze 19:20 (in 42 min) · plan ready'});
    assert.equal(narrow.text, 'waiting');
    assert.equal(narrow.name, ' Flat Route');
    assert.equal(narrow.tip, 'Next TT: Urumaze 19:20 (in 42 min) · plan ready');
    assert.equal(outOfStepWords(-429.4), 'plan off by 429 m');
});

test('the plan panel hint offers a strategy only when there is one to pick, and after the finish says it is for the next ride', () => {
    assert.match(planPanelHint({status: 'armed', beforeStart: true, choose: true}), /^Pick a strategy, or enter another code/);
    assert.equal(planPanelHint({status: 'armed', beforeStart: true, choose: false}), 'Enter another code. Esc keeps this plan.');
    assert.match(planPanelHint({status: 'racing', beforeStart: false, choose: true}), /^Pick a strategy: the targets change now/);
    assert.equal(planPanelHint({status: 'racing', beforeStart: false, choose: false}), 'This plan has no other strategy. Esc keeps this plan.');
    const finished = planPanelHint({status: 'finished', beforeStart: false, choose: true});
    assert.match(finished, /^A strategy picked now is for the next ride/);
    assert.equal(planPanelHint({status: 'finished', beforeStart: false, choose: false}), 'Esc keeps this plan.');
});

// ---- the link ping ----

test('the planner ping tells a planner without linking from one that could not be reached', async () => {
    const answer = (status, json) => fakeFetch(() => ({status, json}));
    assert.equal(await plannerLinkSupport(answer(200, {success: true, link: true})), 'yes');
    assert.equal(await plannerLinkSupport(answer(200, {success: true})), 'no');           // an old planner answers the page, not link.php
    assert.equal(await plannerLinkSupport(fakeFetch(() => ({status: 200, text: '<html>'}))), 'no');
    assert.equal(await plannerLinkSupport(answer(404, {})), 'no');
    assert.equal(await plannerLinkSupport(answer(410, {})), 'no');
    for (const status of [500, 502, 503, 429, 403]) {
        assert.equal(await plannerLinkSupport(answer(status, {})), 'away', `HTTP ${status}`);
    }
    assert.equal(await plannerLinkSupport(fakeFetch(() => new Error('offline'))), 'away');
    const slow = async () => {
        throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    };
    assert.equal(await plannerLinkSupport(slow), 'away');
});

// ---- the pages and the stylesheets ----

test('the HUD code box takes a pasted planner link (it is longer than the six-letter code)', () => {
    for (const f of ['pages/hud.html', 'pages/hud-dial.html', 'pages/hud-stack.html']) {
        const html = read(f);
        assert.match(html, /id="plan-code" maxlength="80"/, f);
        assert.doesNotMatch(html, /maxlength="6"/, f);
        assert.match(html, /id="toast-dismiss"[^>]*aria-label="Dismiss"/, f);
    }
});

test('the hover tray also shows while a control in it has the keyboard focus', () => {
    const css = read('pages/css/hud.css');
    assert.match(css, /\.tray:focus-within,\s*html\.settings-mode \.tray/);
    assert.match(css, /\.hud:has\(\.tray:focus-within\) \.toast/);
});

test('the strip lays cadence, heart rate and speed out in a row, without the cell border', () => {
    const css = read('pages/css/hud.css');
    const rule = css.match(/html\[data-layout="strip"\] \.cell\.vitals \{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /flex-direction: row/);
    assert.match(rule, /border: 0/);
    assert.match(rule, /padding: 0/);
});

test('in the dial the new-plan offer sits inside the circle, clear of the tray, and the W′ words give way to it', () => {
    const css = read('pages/css/hud.css');
    assert.match(css, /html\[data-layout="dial"\] \.toast,[\s\S]*?\{[^}]*top: calc\(var\(--t\) \* 180\); bottom: auto/);
    assert.match(css, /html\[data-layout="dial"\] \.hud\.offering \.wbal \{ visibility: hidden; \}/);
    assert.match(css, /\.hud\.spectating \.dial-svg \{ opacity: 0\.45; \}/);
});

test('what the settings page hides stays hidden whatever the host stylesheet says', () => {
    const css = read('pages/css/settings.css');
    assert.match(css, /#settings label\[hidden\] \{\s*display: none !important;/);
    assert.match(css, /#settings \.section\[hidden\]/);
});

test('the settings page asks the planner without giving up its buttons, and keeps the focus in what it redraws', () => {
    const src = read('pages/src/settings.mjs');
    assert.doesNotMatch(src, /if \(!supported\)/, 'no early return before the link buttons are wired');
    assert.match(src, /plannerLinkSupport/);
    assert.match(src, /Can't reach the planner right now/);
    for (const handler of ["els.unlink.addEventListener('click'", "els.cancel.addEventListener('click'", "els.sync.addEventListener('click'", "els.devices.addEventListener('click'"]) {
        assert.ok(src.indexOf(handler) > 0 && src.indexOf(handler) < src.indexOf('ping();'), `${handler} is attached before the ping is asked`);
    }
    assert.doesNotMatch(src, /(?<!status)\.innerHTML = (?!html)/, 'lists go through setMarkup (the races status line has nothing to focus)');
    assert.match(src, /data-device="\$\{esc\(d\.id\)\}"/);
    assert.match(src, /document\.createElement\('button'\)/, 'the update link is a button');
});

test('the list shows no negative zero and says what its finish figure is', () => {
    const src = read('pages/src/list.mjs');
    assert.match(src, /fmtWattDelta\(d\)/);
    assert.match(src, /figureText\(fig\)/);
    assert.match(src, /rideAverage\(v\.stats, 10\)/);
    assert.doesNotMatch(src, /\$\{g\.toFixed\(1\)\}%/, "a grade goes through fmtGrade");
});
