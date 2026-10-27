// The pages and the manifest agree (docs/REVAMP_PLAN.md 3.3): every manifest window's file
// exists and is unique (Sauce rejects duplicates), the three HUD pages differ only in their
// layout and title, and every page's stylesheet and module paths resolve.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('manifest windows point at existing, distinct pages with distinct ids', () => {
    const files = manifest.windows.map(w => w.file);
    const ids = manifest.windows.map(w => w.id);
    assert.equal(new Set(files).size, files.length, 'window files must be unique');
    assert.equal(new Set(ids).size, ids.length, 'window ids must be unique');
    for (const f of files) {
        assert.ok(existsSync(join(root, f)), `${f} exists`);
    }
    assert.equal(manifest.id, 'zwiftgopher-tt');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('the HUD pages are one page with three layouts', () => {
    const strip = read('pages/hud.html');
    for (const [file, layout] of [['pages/hud-dial.html', 'dial'], ['pages/hud-stack.html', 'stack']]) {
        const page = read(file);
        const normalised = page
            .replace(`data-layout="${layout}"`, 'data-layout="strip"')
            .replace(`<title>TT HUD ${layout}</title>`, '<title>TT HUD</title>')
            .replace(`<div class="title">TT HUD ${layout}</div>`, '<div class="title">TT HUD</div>');
        assert.equal(normalised, strip, `${file} differs from hud.html beyond its layout and title`);
    }
});

test('every page resolves its local stylesheets and modules', () => {
    for (const w of manifest.windows.concat([{file: 'pages/settings.html'}])) {
        const html = read(w.file);
        for (const m of html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)) {
            assert.ok(existsSync(join(root, 'pages', m[1])), `${w.file} references ${m[1]}`);
        }
        for (const m of html.matchAll(/from '\.\/([^']+)'/g)) {
            assert.ok(existsSync(join(root, 'pages', m[1])), `${w.file} imports ${m[1]}`);
        }
    }
});

test('the HUD settings key is shared by the HUD pages and the settings page', () => {
    for (const f of ['pages/hud.html', 'pages/hud-dial.html', 'pages/hud-stack.html']) {
        assert.match(read(f), /data-settings-key="zg-tt-hud"/);
    }
    assert.match(read('pages/src/settings.mjs'), /hud: 'zg-tt-hud'/);
});

test('every window page has the settings key the settings page writes for it', () => {
    const settings = read('pages/src/settings.mjs');
    const keys = Object.fromEntries([...settings.matchAll(/(\w+): '(zg-tt-[\w-]+)'/g)].map(m => [m[1], m[2]]));
    const forOf = {'pages/hud.html': 'hud', 'pages/hud-dial.html': 'hud', 'pages/hud-stack.html': 'hud', 'pages/list.html': 'list', 'pages/field.html': 'field', 'pages/rivals.html': 'rivals'};
    for (const w of manifest.windows) {
        const html = read(w.file);
        const key = html.match(/data-settings-key="([^"]+)"/)?.[1];
        assert.equal(key, keys[forOf[w.file]], `${w.file} settings key`);
        const link = html.match(/href="settings\.html\?for=(\w+)/)?.[1];
        assert.equal(link, forOf[w.file], `${w.file} opens its own settings`);
    }
});
