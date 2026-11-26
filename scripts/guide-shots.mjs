#!/usr/bin/env node
// Screenshots for the user guide (ZwiftGopher TT/guide.php), taken from a real run of both
// ends: the planner on a local server and the mod's windows on the Sauce stand-in
// (scripts/sauce-standin). The mod pairs with the planner, the planner sends an optimised
// plan for an upcoming time trial, the HUD picks it up; the racing moments come from a
// recording. Needs the planner running locally with the link migration applied.
//
//   node scripts/guide-shots.mjs --planner=http://127.0.0.1:8080/TT --out=../ZwiftGopher/TT/images/guide [--webp] [--race=cd]
//
// --webp converts every PNG to WebP (quality 86) and removes the PNG, as the guide uses them;
// it needs python3 with Pillow.
// --race=cd takes the racing moments from the anonymised California Dreamin' TT of 2026-11-10
// (test/fixtures/recordings, staged in pages/fixtures as cd.* for the run and removed after) with
// the planner's plan for it: the pictures the guide and the mod page show. The default is the
// synthetic flat TT with its six made-up rivals.
// $CHROME runs that browser (say /usr/bin/google-chrome) instead of Playwright's own.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {start} from './sauce-standin/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'x.js'));
const {chromium} = require('playwright');
const opt = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const PLANNER = String(opt.planner || 'http://127.0.0.1:8080/TT').replace(/\/$/, '');
const OUT = opt.out || join(here, '..', 'docs', 'guide');
const CASES = opt.cases || join(here, '..', '..', 'ZwiftGopher', 'TT', 'fixtures', 'planner', 'cases.json');
const PORT = 1090;
const MOD = `http://127.0.0.1:${PORT}/mods/zwiftgopher-tt/pages`;
const BG = {
    snow: 'linear-gradient(180deg, #8fc3ff 0%, #dfe9f3 44%, #ffffff 46%, #e6ecf3 100%)',
    jungle: 'linear-gradient(160deg, #2f5e2a 0%, #6c9a3b 35%, #d9c37a 50%, #1e3d1c 70%, #9bb86a 100%)',
    night: 'linear-gradient(180deg, #050812 0%, #121a33 60%, #2a2f3a 100%)',
};
// The racing moments, in seconds of the recording, and the extra wait the field and rivals need
// for their history before the shot.
const RACES = {
    synthetic: {replay: 'synthetic-flat-tt', plan: 'flat.fit.optimise', armed: 20, racing: 200, soon: 349, finished: 940, field: 800, rivals: 500, fieldWait: 0},
    cd: {replay: 'cd', plan: 'cd', source: 'california-dreamin-2026-11-10', armed: 20, racing: 1060, soon: 1029, finished: 2300, field: 1500, rivals: 1500, fieldWait: 3000},
};
const RACE = RACES[opt.race || 'synthetic'];
if (!RACE) {
    throw new Error(`--race is one of ${Object.keys(RACES).join(', ')}`);
}
mkdirSync(OUT, {recursive: true});
const shots = [];
const log = (...a) => console.log(...a);

async function pageOf(context, width, height) {
    const page = await context.newPage();
    await page.setViewportSize({width, height});
    return page;
}

/** The Share dialog from its top to the end of its Sauce block (the QR and links below are not the point). */
async function shareShot(page, name) {
    const box = await page.evaluate(() => {
        const top = document.querySelector('#tt-share-modal .modal-content').getBoundingClientRect();
        const end = document.getElementById('tt-sauce').getBoundingClientRect();
        return {x: top.x, y: top.y, width: top.width, height: end.bottom - top.y + 16};
    });
    await shot(page, name, {clip: box});
}

async function shot(target, name, options = {}) {
    const path = join(OUT, `${name}.png`);
    await target.screenshot({path, ...options});
    shots.push(name);
    log(`  ${name}.png`);
}

// ---- the rider and the event ----
const cases = JSON.parse(readFileSync(CASES, 'utf8'));
const rider = {...cases.riders.fit, name: 'Sample Rider', zwift_id: 354912};
delete rider.about;

const events = await (await fetch(`${PLANNER}/ajax.php`, {method: 'POST', body: new URLSearchParams({action: 'get_events'})})).json();
const now = Date.now();
const event = events.events.find(e => /Urumaze/.test(e.name) && e.plannable && !e.pens_differ && Date.parse(e.start) > now + 20 * 60000)
    ?? events.events.find(e => e.time_trial && e.plannable && !e.pens_differ && Date.parse(e.start) > now + 20 * 60000);
if (!event) {
    throw new Error('No upcoming plannable time trial in the planner\'s event list');
}
const pen = event.pens[1] ?? event.pens[0];
log(`event: ${event.name} at ${event.start}, pen ${pen.label}`);
// What Sauce's event cache would say: the rider signed up for pen B.
const sauceEvents = [{
    id: event.id, name: event.name, eventType: 'TIME_TRIAL', ts: Date.parse(event.start), routeId: Number(event.route_id),
    laps: event.laps, distanceInMeters: event.distance_m, rulesSet: event.rules,
    eventSubgroups: event.pens.map(p => ({id: p.id, subgroupLabel: p.label, signedUp: p.id === pen.id, routeId: Number(p.route_id), laps: p.laps, distanceInMeters: p.distance_m, rulesSet: p.rules})),
}];

const server = await start(PORT);
const browser = await chromium.launch(process.env.CHROME ? {executablePath: process.env.CHROME} : {});
const fixtures = join(here, '..', 'pages', 'fixtures');
const staged = [];
try {
    if (RACE.source) {
        const from = join(here, '..', 'test', 'fixtures', 'recordings', RACE.source);
        staged.push(join(fixtures, `${RACE.replay}.jsonl`), join(fixtures, `${RACE.plan}.json`));
        writeFileSync(staged[0], gunzipSync(readFileSync(`${from}.jsonl.gz`)));
        copyFileSync(`${from}.planner.plan.json`, staged[1]);
    }
    // ---- the mod, before linking ----
    const mod = await browser.newContext({deviceScaleFactor: 2});
    const settings = await pageOf(mod, 460, 820);
    await settings.goto(`${MOD}/settings.html?for=hud`);
    await settings.evaluate(({planner, events}) => {
        localStorage.clear();
        localStorage.setItem('standin:planner', JSON.stringify(planner));
        localStorage.setItem('standin:events', JSON.stringify(events));
    }, {planner: PLANNER, events: sauceEvents});
    await settings.reload();
    await settings.waitForSelector('#link-start:not([disabled])');
    log('mod: settings');
    await shot(settings, 'mod-settings-link');
    await settings.click('#link-start');
    await settings.waitForFunction(() => /^[A-Z2-9]{6}$/.test(document.getElementById('link-code').textContent));
    const code = await settings.textContent('#link-code');
    await shot(settings, 'mod-settings-pairing');
    const hudPending = await pageOf(mod, 230, 430);
    await hudPending.goto(`${MOD}/hud-stack.html`);
    await hudPending.evaluate(bg => document.body.style.background = bg, BG.night);
    await hudPending.waitForFunction(() => !document.getElementById('pairing').hidden);
    await shot(hudPending.locator('#hud'), 'mod-hud-pairing');
    await hudPending.close();

    // ---- the planner: the rider, then link ----
    const plannerCtx = await browser.newContext({deviceScaleFactor: 2, viewport: {width: 1280, height: 1400}});
    const planner = await plannerCtx.newPage();
    planner.on('console', m => { if (m.type() === 'error') log(`  [planner] ${m.text()}`); });
    await planner.goto(`${PLANNER}/?tt_debug=1`);
    await planner.evaluate(r => { localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('tt_rider_data', JSON.stringify(r)); }, rider);
    await planner.goto(`${PLANNER}/?tt_debug=1`);
    await planner.addStyleTag({content: '#tt-toast-container { display: none !important; }'});
    await planner.waitForFunction(() => document.querySelectorAll('#tt-zwift-route option').length > 10 && window.ttPlannerDebug?.events);
    await planner.waitForFunction(() => window.ttPlannerDebug.events.list().length > 0, null, {timeout: 60000});
    // The event first: Share needs a plan on the page (a draft is not sent to Sauce).
    const toggle = planner.locator('[aria-controls="tt-course-form"]');
    await planner.evaluate(value => window.ttPlannerDebug.events.pick(value), `${event.id}:`);
    await planner.waitForFunction(id => window.ttPlannerDebug.getPlan()?.meta?.event?.id === id, event.id, {timeout: 90000});
    await planner.waitForFunction(() => !window.ttPlannerDebug.isBusy());
    log('planner: link');
    await planner.click('#tt-chart-share');
    await planner.waitForSelector('#tt-share-modal.show');
    await planner.waitForTimeout(600);
    await planner.fill('#tt-sauce-code', code);
    await shareShot(planner, 'planner-share-link');
    await planner.click('#tt-sauce-link');
    await planner.waitForFunction(() => document.getElementById('tt-sauce-unlinked').hidden);
    await planner.waitForTimeout(400);
    await planner.evaluate(() => bootstrap.Modal.getInstance(document.getElementById('tt-share-modal'))?.hide());
    await planner.waitForFunction(() => !document.body.classList.contains('modal-open'));

    // ---- the mod, linked and waiting ----
    await settings.waitForFunction(() => !document.getElementById('link-linked').hidden, null, {timeout: 20000});
    const hud = await pageOf(mod, 600, 100);
    await hud.goto(`${MOD}/hud.html?layout=strip`);
    await hud.evaluate(bg => document.body.style.background = bg, BG.jungle);
    await hud.waitForFunction(() => !document.getElementById('next-tt').hidden, null, {timeout: 15000});
    await hud.waitForTimeout(500);
    log('mod: waiting for a plan');
    await shot(hud.locator('#hud'), 'mod-hud-waiting');
    const stack = await pageOf(mod, 230, 430);
    await stack.goto(`${MOD}/hud-stack.html`);
    await stack.evaluate(bg => document.body.style.background = bg, BG.jungle);
    await stack.waitForFunction(() => !document.getElementById('next-tt').hidden, null, {timeout: 15000});
    await shot(stack, 'mod-hud-stack-waiting');
    await stack.close();

    // ---- the planner: the event, the plan ----
    // The mod has reported the sign-up by now: the picker marks it.
    await planner.waitForTimeout(1500);
    await planner.evaluate(() => window.ttPlannerDebug.events.reload());
    await planner.waitForTimeout(800);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
    }
    await planner.evaluate(() => { document.getElementById('tt-event-age').textContent = ''; document.getElementById('tt-event-pick').scrollIntoView({block: 'start'}); });
    await planner.evaluate(() => window.scrollBy(0, -90));
    log('planner: event picker');
    await shot(planner.locator('section.tt-setup'), 'planner-event-picker');
    await planner.click('[data-event-action="plan"]');
    await planner.waitForFunction(() => window.ttPlannerDebug.lifecycle.origin === 'optimised', null, {timeout: 120000});
    await planner.waitForFunction(() => !window.ttPlannerDebug.isBusy() && !document.body.classList.contains('modal-open'), null, {timeout: 30000});
    await toggle.click();
    await planner.waitForFunction(() => window.ttPlannerDebug.link.lastSent()?.code, null, {timeout: 20000}).catch(async err => {
        // The planner says why in a toast (hidden for the pictures).
        log(`  planner toasts: ${await planner.evaluate(() => document.getElementById('tt-toast-container')?.innerText.trim() || '(none)')}`);
        log(`  plan origin: ${await planner.evaluate(() => window.ttPlannerDebug.lifecycle?.origin)}, linked: ${await planner.evaluate(() => Boolean(window.ttPlannerDebug.link.getLink()?.token))}`);
        throw err;
    });

    // ---- the mod picks it up ----
    // Away from its pen and its route the plan is offered (mod 0.8.1): Use loads it.
    await hud.evaluate(() => window.zgtt.api.syncNow());
    await hud.waitForFunction(() => window.zgtt.view().plan || !document.getElementById('toast').hidden, null, {timeout: 20000});
    if (!(await hud.evaluate(() => Boolean(window.zgtt.view().plan)))) {
        await hud.click('#toast-use');
        await hud.mouse.move(700, 400);    // off the HUD, or its hover tray stays up
    }
    await hud.waitForFunction(() => window.zgtt.view().plan, null, {timeout: 20000});
    // The next-TT line is worked out at start and once a minute (mod 0.9.8), not when a plan
    // arrives: wait for the minute's refresh to say this is the plan for it (a reload would
    // lose the W' the stand-in cannot work out again without the game).
    await hud.waitForFunction(() => /this plan/.test(document.getElementById('banner')?.textContent ?? ''), null, {timeout: 70000});
    await hud.setViewportSize({width: 600, height: 100});
    await hud.waitForTimeout(800);
    log('mod: the plan arrived');
    await shot(hud, 'mod-hud-arrived');

    // ---- the planner: Sauce has it, the shelf ----
    await planner.click('#tt-chart-share');
    await planner.waitForSelector('#tt-share-modal.show');
    await planner.waitForFunction(() => /Sauce has it/.test(document.getElementById('tt-sauce-state').textContent), null, {timeout: 30000});
    await planner.waitForTimeout(300);
    log('planner: Sauce has it');
    await shareShot(planner, 'planner-share-linked');
    await planner.evaluate(() => bootstrap.Modal.getInstance(document.getElementById('tt-share-modal'))?.hide());
    await planner.waitForFunction(() => !document.body.classList.contains('modal-open'));
    // The plan, once the mod has it: the pill by the time says In Sauce.
    await planner.evaluate(() => window.scrollTo(0, 0));
    await planner.waitForFunction(() => /In Sauce/.test(document.getElementById('tt-sauce-pill')?.textContent ?? ''), null, {timeout: 15000}).catch(() => log('  (the pill does not say In Sauce yet)'));
    await planner.waitForTimeout(800);
    log('planner: the plan');
    await shot(planner, 'planner-plan', {clip: {x: 0, y: 0, width: 1280, height: 860}});
    await shot(planner.locator('#tt-plan .tt-plan-head'), 'planner-plan-head');
    await planner.click('#tt-load-plan');
    await planner.waitForFunction(() => document.querySelectorAll('#tt-load-shelf-list button[data-code]').length > 0, null, {timeout: 15000});
    await planner.waitForTimeout(300);
    await shot(planner.locator('#tt-load-plan-modal .modal-content'), 'planner-load-shelf');
    await planner.evaluate(() => bootstrap.Modal.getInstance(document.getElementById('tt-load-plan-modal'))?.hide());

    // ---- the mod's settings, linked ----
    await settings.reload();
    await settings.waitForFunction(() => !document.getElementById('link-linked').hidden && document.querySelectorAll('#link-devices li').length >= 2, null, {timeout: 15000});
    await settings.waitForFunction(() => !document.getElementById('next-tts').hidden, null, {timeout: 15000});
    await settings.waitForTimeout(300);
    log('mod: settings linked');
    await shot(settings, 'mod-settings-linked');
    await settings.evaluate(() => document.getElementById('pacing').scrollIntoView());
    await settings.waitForTimeout(200);
    await shot(settings, 'mod-settings-advanced');

    // ---- the race moments, from the synthetic recording ----
    const arrived = await hud.evaluate(() => window.zgtt.store.getActiveCode());
    const moment = async (file, size, seek, bg, name, prep = null) => {
        const page = await pageOf(mod, size[0], size[1]);
        await page.goto(`${MOD}/${file}${file.includes('?') ? '&' : '?'}replay=${RACE.replay}&plan=${RACE.plan}&speed=1&seek=${seek}&bg=${bg}`);
        await page.waitForFunction(() => window.zgtt && window.zgtt.view().plan && window.zgtt.view().status !== 'idle', null, {timeout: 20000});
        await page.waitForTimeout(900 + (/^(field|rivals)/.test(file) ? RACE.fieldWait : 0));
        if (prep) {
            await prep(page);
            await page.waitForTimeout(400);
        }
        await shot(page, name);
        await page.close();
    };
    log('mod: race moments');
    await moment('hud.html', [600, 100], RACE.armed, 'jungle', 'mod-hud-armed');
    await moment('hud.html', [600, 100], RACE.armed, 'jungle', 'mod-hud-toast', async page => {
        await page.evaluate(code => {
            const e = window.zgtt.store.getPlanEntry(code);
            window.zgtt.store.setShelf({offer: {code, routeName: e?.routeName ?? 'Urumaze', timeText: e?.timeText ?? null, at: Date.now()}});
            window.zgtt.api.draw();
        }, arrived);
    });
    await moment('hud.html', [600, 100], RACE.armed, 'jungle', 'mod-hud-strategy', async page => {
        await page.click('#banner .chip');
        // A plan code as the planner gives one, not the replay's REPLAY (the HUD redraws the
        // title every tick, so it is swapped on every redraw).
        await page.evaluate(() => {
            const swap = () => {
                for (const el of document.querySelectorAll('#idle .title')) {
                    if (el.textContent.includes('REPLAY')) {
                        el.textContent = el.textContent.replace('REPLAY', 'K7M2QX');
                    }
                }
            };
            swap();
            new MutationObserver(swap).observe(document.getElementById('idle'), {subtree: true, childList: true, characterData: true});
        });
    });
    await moment('hud.html', [600, 100], RACE.racing, 'snow', 'mod-hud-racing');
    await moment('hud.html', [600, 100], RACE.soon, 'snow', 'mod-hud-soon');
    await moment('hud.html', [600, 100], RACE.finished, 'night', 'mod-hud-finished');
    await moment('hud-dial.html', [320, 320], RACE.racing, 'jungle', 'mod-hud-dial');
    await moment('hud-stack.html', [230, 430], RACE.soon, 'snow', 'mod-hud-stack');
    await moment('list.html', [400, 500], RACE.soon, 'snow', 'mod-list');
    await moment('field.html', [400, 500], RACE.field, 'night', 'mod-field');
    await moment('rivals.html', [600, 76], RACE.rivals, 'jungle', 'mod-rivals');
    await moment('hud.html', [600, 100], RACE.racing, 'snow', 'mod-hud-tray', async page => {
        await page.evaluate(() => document.getElementById('hud').classList.add('tray-pinned'));
    });

    // Plan it: in the pen of an event with no plan for it.
    const planIt = await pageOf(mod, 600, 100);
    await planIt.goto(`${MOD}/hud.html?replay=synthetic-flat-tt&speed=1&seek=20&bg=jungle`);
    await planIt.waitForFunction(() => window.zgtt && window.zgtt.view().event?.inEvent, null, {timeout: 20000});
    // No plan and no offer (the toast picture's offer is in the shared store).
    await planIt.evaluate(() => { window.zgtt.store.setShelf({offer: null}); window.zgtt.store.setActive(null); window.zgtt.api.draw(); });
    await planIt.waitForFunction(() => !document.getElementById('next-tt-plan').hidden, null, {timeout: 10000}).catch(() => {});
    await planIt.waitForTimeout(500);
    await shot(planIt.locator('#hud'), 'mod-hud-plan-it');
    await planIt.close();
    await hud.close();
} finally {
    await browser.close();
    server.close();
    for (const file of staged) {
        rmSync(file, {force: true});
    }
}
if (opt.webp) {
    const py = "import sys,os\nfrom PIL import Image\nfor f in sys.argv[1:]:\n    Image.open(f).save(f[:-4] + '.webp', 'WEBP', quality=86, method=6)\n    os.remove(f)";
    const r = spawnSync('python3', ['-c', py, ...shots.map(n => join(OUT, `${n}.png`))], {stdio: 'inherit'});
    if (r.status !== 0) {
        throw new Error('WebP conversion failed (python3 with Pillow is needed)');
    }
}
log(`\n${shots.length} screenshots in ${OUT}${opt.webp ? ' (WebP)' : ''}`);
