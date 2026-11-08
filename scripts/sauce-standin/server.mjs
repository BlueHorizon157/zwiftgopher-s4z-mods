#!/usr/bin/env node
// A stand-in for Sauce4Zwift's web server: serves the mod at /mods/zwiftgopher-tt/ and the
// few Sauce files its pages load (common.mjs, common.css, the icons), so the windows open in
// any browser for screenshots (scripts/guide-shots.mjs) and quick looks. It is not Sauce:
// there is no game data, the windows' ?replay= mode supplies telemetry.
//
//   node scripts/sauce-standin/server.mjs [--port=1090]
//   then http://127.0.0.1:1090/mods/zwiftgopher-tt/pages/hud.html?replay=synthetic-flat-tt&plan=flat.fit.optimise
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const TYPES = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.png': 'image/png', '.svg': 'image/svg+xml'};

function resolve(pathname) {
    if (pathname === '/pages/src/common.mjs') {
        return join(here, 'common.mjs');
    }
    if (pathname === '/pages/css/common.css') {
        return join(here, 'common.css');
    }
    if (pathname === '/pages/images/favicon.png' || pathname === '/pages/images/icon128.png') {
        return join(repo, 'docs', 'brand', 'logo.png');
    }
    const prefix = '/mods/zwiftgopher-tt/';
    if (pathname.startsWith(prefix)) {
        const file = normalize(join(repo, decodeURIComponent(pathname.slice(prefix.length))));
        return file.startsWith(repo) ? file : null;
    }
    return null;
}

export function start(port = 1090) {
    const server = createServer(async (req, res) => {
        const file = resolve(new URL(req.url, 'http://x').pathname);
        try {
            if (!file) {
                throw new Error('not found');
            }
            const body = await readFile(file);
            res.writeHead(200, {'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'});
            res.end(body);
        } catch {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('not found');
        }
    });
    return new Promise(ok => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const port = Number(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 1090;
    await start(port);
    console.log(`Sauce stand-in on http://127.0.0.1:${port}/mods/zwiftgopher-tt/pages/`);
}
