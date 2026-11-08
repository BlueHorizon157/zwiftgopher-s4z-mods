#!/usr/bin/env node
// Screenshots for the user guide (ZwiftGopher TT/guide.php), taken from a real run of both
// ends: the planner on a local server and the mod's windows on the Sauce stand-in
// (scripts/sauce-standin). The mod pairs with the planner, the planner sends an optimised
// plan for an upcoming time trial, the HUD picks it up; the racing moments come from the
// synthetic recording. Needs the planner running locally with the link migration applied.
//
//   node scripts/guide-shots.mjs --planner=http://127.0.0.1:8080/TT --out=../ZwiftGopher/TT/images/guide [--webp]
//
// --webp converts every PNG to WebP (quality 86) and removes the PNG, as the guide uses them;
// it needs python3 with Pillow.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync} from 'node:fs';
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
const browser = await chromium.launch();
try {
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
    const hud = await pageOf(mod, 600, 240);
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
    await planner.evaluate(() => { document.getElementById('tt-event-age').textContent = ''; document.getElementById('tt-event-select').scrollIntoView({block: 'start'}); });
    await planner.evaluate(() => window.scrollBy(0, -90));
    log('planner: event picker');
    await shot(planner.locator('section.tt-setup'), 'planner-event-picker');
    await planner.click('[data-event-action="plan"]');
    await planner.waitForFunction(() => window.ttPlannerDebug.lifecycle.origin === 'optimised', null, {timeout: 120000});
    await planner.waitForFunction(() => !window.ttPlannerDebug.isBusy() && !document.body.classList.contains('modal-open'), null, {timeout: 30000});
    await toggle.click();
    await planner.evaluate(() => window.scrollTo(0, 0));
    await planner.waitForTimeout(800);
    log('planner: the plan');
    await shot(planner, 'planner-plan', {clip: {x: 0, y: 0, width: 1280, height: 860}});
    await shot(planner.locator('#tt-plan .tt-plan-head'), 'planner-plan-head');
    await planner.waitForFunction(() => window.ttPlannerDebug.link.lastSent()?.code, null, {timeout: 20000});

    // ---- the mod picks it up ----
    await hud.evaluate(() => window.zgtt.api.syncNow());
    await hud.waitForFunction(() => window.zgtt.view().plan, null, {timeout: 20000});
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
        await page.goto(`${MOD}/${file}${file.includes('?') ? '&' : '?'}replay=synthetic-flat-tt&plan=flat.fit.optimise&speed=1&seek=${seek}&bg=${bg}`);
        await page.waitForFunction(() => window.zgtt && window.zgtt.view().plan && window.zgtt.view().status !== 'idle', null, {timeout: 20000});
        await page.waitForTimeout(900);
        if (prep) {
            await prep(page);
            await page.waitForTimeout(400);
        }
        await shot(page, name);
        await page.close();
    };
    log('mod: race moments');
    await moment('hud.html', [600, 100], 20, 'jungle', 'mod-hud-armed');
    await moment('hud.html', [600, 100], 20, 'jungle', 'mod-hud-toast', async page => {
        await page.evaluate(code => {
            const e = window.zgtt.store.getPlanEntry(code);
            window.zgtt.store.setShelf({offer: {code, routeName: e?.routeName ?? 'Urumaze', timeText: e?.timeText ?? null, at: Date.now()}});
            window.zgtt.api.draw();
        }, arrived);
    });
    await moment('hud.html', [600, 100], 20, 'jungle', 'mod-hud-strategy', async page => {
        await page.click('#banner .chip');
    });
    await moment('hud.html', [600, 100], 200, 'snow', 'mod-hud-racing');
    await moment('hud.html', [600, 100], 349, 'snow', 'mod-hud-soon');
    await moment('hud.html', [600, 100], 940, 'night', 'mod-hud-finished');
    await moment('hud-dial.html', [320, 320], 200, 'jungle', 'mod-hud-dial');
    await moment('hud-stack.html', [230, 430], 349, 'snow', 'mod-hud-stack');
    await moment('list.html', [400, 500], 349, 'snow', 'mod-list');
    await moment('field.html', [400, 500], 500, 'night', 'mod-field');
    await moment('rivals.html', [600, 76], 500, 'jungle', 'mod-rivals');
    await moment('hud.html', [600, 100], 200, 'snow', 'mod-hud-tray', async page => {
        await page.evaluate(() => document.getElementById('hud').classList.add('tray-pinned'));
    });

    // Plan it: in the pen of an event with no plan for it.
    const planIt = await pageOf(mod, 600, 240);
    await planIt.goto(`${MOD}/hud.html?replay=synthetic-flat-tt&speed=1&seek=20&bg=jungle`);
    await planIt.waitForFunction(() => window.zgtt && window.zgtt.view().event?.inEvent, null, {timeout: 20000});
    await planIt.evaluate(() => { window.zgtt.store.setActive(null); window.zgtt.api.draw(); });
    await planIt.waitForFunction(() => !document.getElementById('next-tt-plan').hidden, null, {timeout: 10000}).catch(() => {});
    await planIt.waitForTimeout(500);
    await shot(planIt.locator('#hud'), 'mod-hud-plan-it');
    await planIt.close();
    await hud.close();
} finally {
    await browser.close();
    server.close();
}
if (opt.webp) {
    const py = "import sys,os\nfrom PIL import Image\nfor f in sys.argv[1:]:\n    Image.open(f).save(f[:-4] + '.webp', 'WEBP', quality=86, method=6)\n    os.remove(f)";
    const r = spawnSync('python3', ['-c', py, ...shots.map(n => join(OUT, `${n}.png`))], {stdio: 'inherit'});
    if (r.status !== 0) {
        throw new Error('WebP conversion failed (python3 with Pillow is needed)');
    }
}
log(`\n${shots.length} screenshots in ${OUT}${opt.webp ? ' (WebP)' : ''}`);
