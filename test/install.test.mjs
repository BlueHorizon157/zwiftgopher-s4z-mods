// What a rider installs (the release zip: git archive, less .gitattributes' export-ignore) can be
// copied by hand into SauceMods. Two shipped files with one name in different folders make
// Windows ask to replace one with the other when files are copied rather than the folder
// (a rider's report, 2026-11: an error naming field.mjs, then a field window that did not work).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = ['test/', 'docs/', 'pages/fixtures/', 'scripts/', '.gitattributes', '.gitignore', 'package.json'];
const shipped = execSync('git ls-files', {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean)
    .filter(f => !ignored.some(i => (i.endsWith('/') ? f.startsWith(i) : f === i)));

test('no two shipped files share a name', () => {
    const seen = new Map();
    const clashes = [];
    for (const f of shipped) {
        const name = f.split('/').at(-1).toLowerCase();
        if (seen.has(name)) {
            clashes.push(`${seen.get(name)} and ${f}`);
        }
        seen.set(name, f);
    }
    assert.deepEqual(clashes, []);
});

test('shipped paths stay short and plain (Windows, zip tools)', () => {
    for (const f of shipped) {
        assert.ok(f.length <= 80, `${f} is ${f.length} characters`);
        assert.match(f, /^[A-Za-z0-9._/-]+$/, `${f} has characters a zip tool may mangle`);
    }
    assert.ok(shipped.includes('manifest.json'));
});
