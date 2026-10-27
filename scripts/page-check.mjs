#!/usr/bin/env node
// Runs the mod's windows in headless Chrome against a running Sauce4Zwift web server
// (docs/REVAMP_PLAN.md Phase 0.3 and 3.6). Two passes:
//   replay  each engine page plays a whole recording; console errors and exceptions are
//           collected, the engine's final view is checked and a screenshot saved;
//   looks   the HUD layouts are opened at chosen moments of the recording (pre-start,
//           mid-race, the boundary moment, finished) over stand-in backgrounds (snow,
//           jungle, night) and screenshotted, for the README and for eyeballing.
//
//   node scripts/page-check.mjs [--base=http://127.0.0.1:1080] [--replay=synthetic-flat-tt]
//        [--plan=flat.fit.optimise] [--speed=20] [--out=/tmp/zg-page-check]
//        [--pages=hud,hud-dial,hud-stack,list,field,rivals,settings]
//        [--replays=1|0] [--looks=1|0] [--moments=armed:20,racing:200,soon:349,finished:940] [--backgrounds=snow,jungle,night]
// Needs Sauce running with the web server on (Settings → Web server) and the mod enabled;
// the mod id is zwiftgopher-tt. Chrome: /usr/bin/google-chrome or $CHROME.
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const opt = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const BASE = (opt.base || 'http://127.0.0.1:1080').replace(/\/$/, '');
const REPLAY = opt.replay || 'synthetic-flat-tt';
const PLAN = opt.plan || 'flat.fit.optimise';
const SPEED = Number(opt.speed) || 20;
const OUT = opt.out || join(tmpdir(), 'zg-page-check');
const PAGES = String(opt.pages || 'hud,hud-dial,hud-stack,list,field,rivals,settings').split(',');
const LOOKS = opt.looks == null ? true : !['0', 'false', 'no'].includes(String(opt.looks));
const STRATEGY = opt.strategy == null ? true : !['0', 'false', 'no'].includes(String(opt.strategy));
const REPLAYS = opt.replays == null ? true : !['0', 'false', 'no'].includes(String(opt.replays));
const BACKGROUNDS = String(opt.backgrounds || 'snow,jungle,night').split(',');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = 9400 + Math.floor(Math.random() * 400);
const MOD = `${BASE}/mods/zwiftgopher-tt/pages`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Window sizes follow the manifest's default bounds; moments are the looks pass's.
const SIZES = {
    hud: [600, 100], 'hud-dial': [320, 320], 'hud-stack': [230, 430],
    list: [400, 500], field: [400, 500], rivals: [600, 76], settings: [420, 720],
};
const KIND = page => (page.startsWith('hud') ? 'hud' : page);
const PAGE_MOMENTS = {hud: null, list: ['racing', 'soon', 'finished'], field: ['racing', 'finished'], rivals: ['racing', 'finished']};
const IDLE = {hud: '#idle', list: '#empty'};
// Moments in the synthetic flat recording (seconds; released at 30): in the pen, mid
// interval 1, 9 s before interval 3, after the finish. Another recording, or the same one
// rebuilt from a new plan, needs its own --moments=name:seek.
const MOMENTS = Object.fromEntries(String(opt.moments || 'armed:20,racing:200,soon:349,finished:940').split(',')
    .map(m => m.split(':')).map(([k, v]) => [k, Number(v)]));

async function launch() {
    const profile = mkdtempSync(join(tmpdir(), 'zg-page-check-'));
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=600,600', 'about:blank'], {stdio: 'ignore'});
    let targets = [];
    for (let i = 0; i < 75; i++) {
        try {
            targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
            if (targets.find(t => t.type === 'page')) {
                break;
            }
        } catch { /* starting */ }
        await sleep(200);
    }
    const page = targets.find(t => t.type === 'page');
    if (!page) {
        throw new Error(`Chrome did not start (${CHROME})`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    const api = {console: []};
    ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const {resolve, reject} = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            return;
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            api.console.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
        } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
            api.console.push(`console.${msg.params.type} ${msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
        } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            api.console.push(`${msg.params.entry.source} ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
        }
        listeners.forEach(fn => fn(msg));
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, {resolve, reject});
        ws.send(JSON.stringify({id: mid, method, params}));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    Object.assign(api, {
        send,
        async size(width, height) {
            await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
        },
        async goto(url) {
            const loaded = new Promise(resolve => listeners.push(function onLoad(m) {
                if (m.method === 'Page.loadEventFired') {
                    listeners.splice(listeners.indexOf(onLoad), 1);
                    resolve();
                }
            }));
            await send('Page.navigate', {url});
            await loaded;
        },
        async eval(expression) {
            const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
            if (r.exceptionDetails) {
                throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            }
            return r.result.value;
        },
        async waitFor(expression, timeoutMs) {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
                if (await api.eval(`Boolean(${expression})`)) {
                    return true;
                }
                await sleep(250);
            }
            return false;
        },
        async screenshot(path) {
            const r = await send('Page.captureScreenshot', {format: 'png'});
            writeFileSync(path, Buffer.from(r.data, 'base64'));
        },
        errors() {
            return api.console.filter(l => !/favicon|ERR_CONNECTION|api\/ws\/events|WebSocket|api.github.com/.test(l));
        },
        async close() {
            try { ws.close(); } catch { /* closing */ }
            chrome.kill('SIGKILL');
            await sleep(200);
            rmSync(profile, {recursive: true, force: true});
        },
    });
    return api;
}

const VIEW_EXPR = '(() => { const v = window.zgtt.view(); return {status: v.status, signal: v.race.signal, elapsed: v.race.elapsedS, delta: v.race.deltaS, completed: v.race.completed, wbal: v.wbal?.kj, target: v.target?.powerW, next: v.next?.powerW, inS: v.next?.inS, spectating: v.spectating}; })()';
// The smallest visible text in the window's <main>: nothing may fall under 11 px.
const MINFONT_EXPR = `(() => { const root = document.querySelector('main'); if (!root) return null; let min = 99, which = null; const shown = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; } return el.getClientRects().length > 0; }; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (!n.textContent.trim()) continue; const el = n.parentElement; if (!shown(el)) continue; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < min) { min = fs; which = (el.className || el.tagName) + ': ' + n.textContent.trim().slice(0, 20); } } return {min: Math.round(min * 10) / 10, which}; })()`;
const WINDOW_EXPR = `(() => ({listRows: document.querySelectorAll('#list .row').length, listNow: document.querySelector('#list .row.now')?.dataset.index ?? null, fieldRows: document.querySelectorAll('#field .row').length, fieldHome: Boolean(document.querySelector('#field .row.home')), fieldStale: document.querySelectorAll('#field .row.stale').length, rivalsNamed: document.querySelectorAll('#rivals .side li').length, rivalsDots: document.querySelectorAll('#rivals .dot').length, place: document.getElementById('place')?.textContent ?? null, head: [...document.querySelectorAll('.head .line, .head > span')].map(e => e.textContent.trim().replace(/\\s+/g, ' ')).filter(Boolean).slice(0, 4), sides: [...document.querySelectorAll('#rivals .side li')].map(li => li.textContent.trim().replace(/\\s+/g, ' '))}))()`;
const DOM_EXPR = `(() => { const ids = ['now-label','now-w','live-w','band-word','next-label','next-w','next-in-m','next-in-s','wbal-kj','wbal-word','finish-label','finish-time','finish-delta','banner','idle-title','plan-route','summary-duration','spectate-banner']; const o = {}; for (const id of ids) { const el = document.getElementById(id); if (el) o[id] = (el.hidden ? '[hidden] ' : '') + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60); } o.hudClass = document.getElementById('hud')?.className ?? null; o.rows = document.querySelectorAll('#interval-table tbody tr').length; const lbl = document.getElementById('now-label'); o.u = lbl ? parseFloat(getComputedStyle(lbl).fontSize).toFixed(1) : null; return o; })()`;

mkdirSync(OUT, {recursive: true});
const b = await launch();
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL: ${msg}`); };
try {
    // Pass 1: whole replays.
    for (const page of REPLAYS ? PAGES : []) {
        b.console.length = 0;
        const [w, h] = SIZES[page] ?? [400, 500];
        await b.size(w, h);
        const file = page === 'settings' ? 'settings.html?for=hud&' : `${page}.html?replay=${REPLAY}&plan=${PLAN}&speed=${SPEED}&`;
        const url = `${MOD}/${file}windowId=zg-check-${page}`;
        console.log(`\n== ${page} (${w}x${h}): ${url}`);
        await b.goto(url);
        await sleep(1500);
        const hasEngine = await b.eval('Boolean(window.zgtt)');
        if (hasEngine) {
            const done = await b.waitFor('window.zgtt.replay()?.done', 180000);
            await sleep(1200);
            const v = await b.eval(VIEW_EXPR);
            console.log(`replay done: ${done}; view: ${JSON.stringify(v)}`);
            if (!done || v.status !== 'finished') {
                fail('the replay did not finish in the engine');
            }
            console.log('dom:', JSON.stringify(await b.eval(DOM_EXPR)));
            const win = await b.eval(WINDOW_EXPR);
            console.log('window:', JSON.stringify(win));
            if (page === 'list' && win.listRows !== 9) {
                fail(`list: ${win.listRows} rows, expected the plan's 9`);
            }
            if (page === 'field' && (win.fieldRows < 7 || !win.fieldHome)) {
                fail(`field: ${win.fieldRows} rows, home row ${win.fieldHome}`);
            }
            if (page === 'rivals' && win.rivalsDots < 6) {
                fail(`rivals: ${win.rivalsDots} riders on the track`);
            }
        } else if (page === 'settings') {
            // One page for every window: each ?for= shows its own sections.
            const expect = {hud: ['Plans', 'Look', 'Pacing', 'Advanced'], list: ['Plans', 'Look', 'Pacing', 'Advanced'], field: ['Plans', 'Look', 'Field', 'Advanced'], rivals: ['Plans', 'Look', 'Rivals', 'Advanced']};
            for (const [forWin, sections] of Object.entries(expect)) {
                await b.goto(`${MOD}/settings.html?for=${forWin}&windowId=zg-check-settings-${forWin}`);
                await sleep(1200);
                const dom = await b.eval(`(() => ({title: document.title, sections: [...document.querySelectorAll('#settings .section:not([hidden]) .title')].map(e => e.textContent), layoutShown: !document.querySelector('select[name=layout]').closest('label').hidden, fields: [...document.querySelectorAll('#settings .section:not([hidden]) label:not([hidden]) :is(input,select)')].map(e => e.name || e.id)}))()`);
                console.log(`settings for ${forWin}:`, JSON.stringify(dom));
                if (JSON.stringify(dom.sections) !== JSON.stringify(sections) || dom.layoutShown !== (forWin === 'hud')) {
                    fail(`settings for ${forWin}: sections ${dom.sections.join(', ')}, layout shown ${dom.layoutShown}`);
                }
                if (forWin !== 'hud') {
                    await b.screenshot(join(OUT, `settings-${forWin}.png`));
                }
            }
            await b.goto(url);
            await sleep(1200);
        } else {
            await sleep(3000);
            console.log('no engine on this page (expected for the field window)');
        }
        const shot = join(OUT, `${page}.png`);
        await b.screenshot(shot);
        console.log(`screenshot: ${shot}`);
        const errors = b.errors();
        if (errors.length) {
            fail(`console errors (${errors.length}):\n  ${errors.slice(0, 12).join('\n  ')}`);
        } else {
            console.log('console: clean');
        }
    }

    // Pass 2: each window at chosen moments over the stand-in backgrounds, plus the idle
    // state (no plan: the code box) and the HUD's hover tray.
    if (LOOKS) {
        for (const page of PAGES.filter(p => p !== 'settings')) {
            const kind = KIND(page);
            const [w, h] = SIZES[page];
            await b.size(w, h);
            if (IDLE[kind]) {
                const idleUrl = `${MOD}/${page}.html?replay=${REPLAY}&speed=1&seek=20&bg=${BACKGROUNDS[0]}&windowId=zg-idle-${page}`;
                await b.goto(idleUrl);
                await b.eval('localStorage.clear()');     // the plan library is shared by every window (same origin)
                b.console.length = 0;
                await b.goto(idleUrl);
                await sleep(1500);
                const idle = await b.eval(`(() => { const el = document.querySelector('${IDLE[kind]}'); return {hidden: el.hidden, status: window.zgtt.view().status}; })()`);
                const idleShot = join(OUT, `${page}-idle.png`);
                await b.screenshot(idleShot);
                console.log(`\n-- ${page} idle (no plan): ${idleShot}\n   ${JSON.stringify(idle)}`);
                if (idle.hidden || idle.status !== 'idle') {
                    fail(`${page} without a plan: the code box is not shown (${JSON.stringify(idle)})`);
                }
                if (b.errors().length) {
                    fail(`console errors:\n  ${b.errors().slice(0, 6).join('\n  ')}`);
                }
            }
            const moments = Object.entries(MOMENTS).filter(([m]) => !PAGE_MOMENTS[kind] || PAGE_MOMENTS[kind].includes(m));
            for (const [moment, seek] of moments) {
                for (const bg of moment === 'racing' ? BACKGROUNDS : [BACKGROUNDS[0]]) {
                    b.console.length = 0;
                    const url = `${MOD}/${page}.html?replay=${REPLAY}&plan=${PLAN}&speed=1&seek=${seek}&bg=${bg}&windowId=zg-look-${page}`;
                    await b.goto(url);
                    await b.waitFor('window.zgtt && window.zgtt.replay() && window.zgtt.replay().elapsed > 0', 10000);
                    await sleep(kind === 'hud' ? 1500 : 2500);
                    const v = await b.eval(VIEW_EXPR);
                    const dom = await b.eval(kind === 'hud' ? DOM_EXPR : WINDOW_EXPR);
                    const font = await b.eval(MINFONT_EXPR);
                    const shot = join(OUT, `${page}-${moment}-${bg}.png`);
                    await b.screenshot(shot);
                    console.log(`\n-- ${page} ${moment} over ${bg} (seek ${seek} s): ${shot}\n   view: ${JSON.stringify(v)}\n   dom: ${JSON.stringify(dom)}\n   smallest text: ${JSON.stringify(font)}`);
                    const expect = {armed: 'armed', racing: 'racing', soon: 'racing', finished: 'finished'}[moment];
                    if (expect && v.status !== expect) {
                        fail(`${page} at ${moment}: engine status ${v.status}, expected ${expect}`);
                    }
                    if (kind === 'hud' && moment === 'soon' && !/\bsoon\b/.test(dom.hudClass ?? '')) {
                        fail(`${page} at ${moment}: the boundary moment is not shown (next in ${v.inS} s)`);
                    }
                    if (kind === 'list' && moment !== 'finished' && dom.listNow == null) {
                        fail(`${page} at ${moment}: no current row`);
                    }
                    if (kind === 'field' && moment === 'racing' && (dom.fieldRows < 7 || !dom.fieldHome)) {
                        fail(`${page} at ${moment}: ${dom.fieldRows} rows, home ${dom.fieldHome}`);
                    }
                    if (kind === 'rivals' && moment === 'racing' && (dom.rivalsNamed < 2 || dom.rivalsDots < 6)) {
                        fail(`${page} at ${moment}: ${dom.rivalsNamed} named, ${dom.rivalsDots} on the track`);
                    }
                    if (font && font.min < 10.95) {
                        fail(`${page}: text at ${font.min} px (${font.which}), under the 11 px floor`);
                    }
                    const errors = b.errors();
                    if (errors.length) {
                        fail(`console errors (${errors.length}):\n  ${errors.slice(0, 6).join('\n  ')}`);
                    }
                    if (moment === 'racing' && bg === BACKGROUNDS[0]) {
                        // Right-click shows Sauce's own titlebar (settings mode) over the window.
                        await b.eval(`document.documentElement.classList.add('settings-mode')`);
                        await sleep(450);
                        const bar = await b.eval(`(() => { const t = document.getElementById('titlebar'); const r = t.getBoundingClientRect(); return {height: Math.round(r.height), top: Math.round(r.top), settings: Boolean(t.querySelector('.open-settings'))}; })()`);
                        const barShot = join(OUT, `${page}-titlebar.png`);
                        await b.screenshot(barShot);
                        console.log(`   titlebar: ${barShot} ${JSON.stringify(bar)}`);
                        if (bar.height < 20 || bar.top !== 0 || !bar.settings) {
                            fail(`${page}: Sauce's titlebar does not show in settings mode (${JSON.stringify(bar)})`);
                        }
                        await b.eval(`document.documentElement.classList.remove('settings-mode')`);
                        await sleep(350);
                    }
                    if (kind === 'hud' && moment === 'racing' && bg === BACKGROUNDS[0]) {
                        await b.eval(`document.getElementById('hud').classList.add('tray-pinned')`);
                        await sleep(300);
                        const trayShot = join(OUT, `${page}-tray-${bg}.png`);
                        await b.screenshot(trayShot);
                        const trayFont = await b.eval(MINFONT_EXPR);
                        console.log(`   tray: ${trayShot} smallest text ${JSON.stringify(trayFont)}`);
                        if (trayFont && trayFont.min < 10.95) {
                            fail(`${page} tray: text at ${trayFont.min} px (${trayFont.which})`);
                        }
                    }
                }
            }
        }
    }

    // Pass 3: the strategy switch (5.2). Before the start the banner's chip opens the plan
    // panel and a card replaces the plan in every window; once racing the choice is locked.
    if (STRATEGY) {
        const huds = PAGES.filter(p => KIND(p) === 'hud');
        const SHOW = `(() => ({panel: !document.getElementById('idle').hidden, chip: document.querySelector('#banner .chip')?.textContent ?? null, choices: [...document.querySelectorAll('#strategy-choices button')].map(x => (x.getAttribute('aria-pressed') === 'true' ? '*' : '') + (x.disabled ? '-' : '') + x.textContent.trim().replace(/\\s+/g, ' ')), card: window.zgtt.engine.state.plan?.card ?? null, strategy: window.zgtt.engine.state.plan?.strategy ?? null, timeText: window.zgtt.engine.state.plan?.timeText ?? null, finish: document.getElementById('finish-time')?.textContent, status: window.zgtt.view().status}))()`;
        for (const [i, page] of huds.entries()) {
            const [w, h] = SIZES[page];
            await b.size(w, h);
            const url = `${MOD}/${page}.html?replay=${REPLAY}&plan=${PLAN}&speed=0.1&seek=20&bg=${BACKGROUNDS[1] ?? BACKGROUNDS[0]}&windowId=zg-strategy-${page}`;
            await b.goto(url);
            if (i === 0) {
                await b.eval('localStorage.clear()');
                await b.goto(url);
            }
            b.console.length = 0;
            await b.waitFor('window.zgtt && window.zgtt.engine.state.plan && window.zgtt.view().status === "armed"', 10000);
            await sleep(800);
            const before = await b.eval(SHOW);
            await b.eval(`document.querySelector('#banner .chip')?.click()`);
            await sleep(400);
            const open = await b.eval(SHOW);
            const font = await b.eval(MINFONT_EXPR);
            const shot = join(OUT, `${page}-strategy.png`);
            await b.screenshot(shot);
            console.log(`\n-- ${page} strategy panel: ${shot}\n   before: ${JSON.stringify(before)}\n   open: ${JSON.stringify(open)}\n   smallest text: ${JSON.stringify(font)}`);
            if (!before.chip || !open.panel || open.choices.length < 3 || !open.choices.some(c => c.startsWith('*'))) {
                fail(`${page}: the strategy chip or panel is missing (${JSON.stringify(open)})`);
            }
            if (font && font.min < 10.95) {
                fail(`${page} strategy panel: text at ${font.min} px (${font.which})`);
            }
            const pick = ['balanced', 'safe_finish', 'fastest'][i % 3];
            await b.eval(`document.querySelector('#strategy-choices button[data-key="${pick}"]')?.click()`);
            await sleep(600);
            const after = await b.eval(SHOW);
            await b.screenshot(join(OUT, `${page}-strategy-${pick}.png`));
            console.log(`   picked ${pick}: ${JSON.stringify(after)}`);
            if (after.strategy !== pick || after.panel || after.status !== 'armed' || after.finish === before.finish) {
                fail(`${page}: picking ${pick} did not ride it (${JSON.stringify(after)})`);
            }
            if (b.errors().length) {
                fail(`console errors:\n  ${b.errors().slice(0, 6).join('\n  ')}`);
            }
        }
        if (huds.length) {
            // Another window opened now rides the same card; the settings page shows it chosen.
            const chosen = ['balanced', 'safe_finish', 'fastest'][(huds.length - 1) % 3];
            await b.size(...SIZES.list);
            await b.goto(`${MOD}/list.html?replay=${REPLAY}&plan=${PLAN}&speed=0.1&seek=20&windowId=zg-strategy-list`);
            await b.waitFor('window.zgtt && window.zgtt.engine.state.plan', 10000);
            await sleep(800);
            const list = await b.eval(`(() => ({strategy: window.zgtt.engine.state.plan.strategy, rows: document.querySelectorAll('#list .row').length, facts: document.getElementById('facts').textContent}))()`);
            console.log(`\n-- list after the switch: ${JSON.stringify(list)}`);
            if (list.strategy !== chosen) {
                fail(`list: rides ${list.strategy}, expected ${chosen}`);
            }
            await b.size(...(SIZES.settings ?? [420, 720]));
            await b.goto(`${MOD}/settings.html?for=hud&windowId=zg-strategy-settings`);
            await sleep(1200);
            const st = await b.eval(`(() => ({shown: !document.getElementById('strategy').hidden, checked: document.querySelector('#strategy-choices input:checked')?.dataset.key ?? null, rows: [...document.querySelectorAll('#strategy-choices .choice')].map(l => l.textContent.trim().replace(/\\s+/g, ' '))}))()`);
            await b.screenshot(join(OUT, 'settings-strategy.png'));
            console.log(`-- settings strategy: ${JSON.stringify(st)}`);
            if (!st.shown || st.checked !== chosen) {
                fail(`settings: strategy ${JSON.stringify(st)}, expected ${chosen} checked`);
            }
            // A share code on the clipboard (5.3): offered in the tray before the start and in
            // the plan panel, read when the window gains focus. Nothing is loaded (that would
            // ask the live planner for a made-up code).
            await b.send('Browser.grantPermissions', {permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: BASE}).catch(err => console.log(`   (clipboard permission: ${err.message})`));
            await b.send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
            for (const [i, page] of huds.entries()) {
                const text = i % 2 ? 'https://zwiftgopher.com/TT/?plan=QW3RTY' : 'QW3RTY';
                await b.size(...SIZES[page]);
                await b.goto(`${MOD}/${page}.html?replay=${REPLAY}&plan=${PLAN}&speed=0.1&seek=20&windowId=zg-clip-${page}`);
                await b.waitFor('window.zgtt && window.zgtt.view().status === "armed"', 10000);
                await b.eval(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
                await b.eval(`window.dispatchEvent(new Event('focus'))`);
                await sleep(400);
                await b.eval(`document.getElementById('hud').classList.add('tray-pinned')`);
                await sleep(300);
                const tray = await b.eval(`(() => { const t = document.getElementById('tray-clip'); return t.hidden ? null : t.textContent; })()`);
                await b.screenshot(join(OUT, `${page}-clipboard-tray.png`));
                await b.eval(`document.querySelector('[data-action="change-plan"]').click()`);
                await sleep(300);
                const panel = await b.eval(`(() => { const c = document.getElementById('clip'); return c.hidden ? null : c.textContent.trim().replace(/\\s+/g, ' '); })()`);
                const font = await b.eval(MINFONT_EXPR);
                const fit = await b.eval(`(() => { const box = document.getElementById('hud').getBoundingClientRect(); return [...document.querySelectorAll('#idle > :not([hidden])')].filter(e => getComputedStyle(e).display !== 'none').every(e => { const r = e.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1; }); })()`);
                await b.screenshot(join(OUT, `${page}-clipboard-panel.png`));
                if (font && font.min < 10.95) {
                    fail(`${page} plan panel: text at ${font.min} px (${font.which})`);
                }
                if (!fit) {
                    fail(`${page} plan panel: something sits outside the window`);
                }
                console.log(`-- clipboard ${JSON.stringify(text)}: tray ${JSON.stringify(tray)}, panel ${JSON.stringify(panel)}`);
                if (tray !== 'Load QW3RTY' || !panel?.startsWith('Load QW3RTY')) {
                    fail(`${page}: the clipboard code is not offered (tray ${tray}, panel ${panel})`);
                }
            }
            await b.eval(`navigator.clipboard.writeText('')`).catch(() => {});

            // Racing: the panel shows the strategy but it cannot be changed.
            const page = huds[0];
            await b.size(...SIZES[page]);
            await b.goto(`${MOD}/${page}.html?replay=${REPLAY}&plan=${PLAN}&speed=1&seek=200&windowId=zg-strategy-race`);
            await b.waitFor('window.zgtt && window.zgtt.view().status === "racing"', 10000);
            await sleep(600);
            await b.eval(`document.querySelector('[data-action="change-plan"]').click()`);
            await sleep(300);
            const racing = await b.eval(SHOW);
            await b.screenshot(join(OUT, `${page}-strategy-racing.png`));
            console.log(`-- ${page} racing, plan panel: ${JSON.stringify(racing)}`);
            if (racing.chip || !racing.choices.length || racing.choices.some(c => !c.replace('*', '').startsWith('-'))) {
                fail(`${page}: strategy changeable while racing (${JSON.stringify(racing)})`);
            }
            // Leave the library as the other passes expect it.
            await b.eval('localStorage.clear()');
        }
    }
} finally {
    await b.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall pages ok');
process.exit(failures ? 1 : 0);
