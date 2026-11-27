// End to end through main(): plan, apply, verify, drift, dirty refusal, rollback, prune, restart, purge.
// The "server" is a temp folder driven by the local bash transport running the real remote scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tmpDir, makeRepo, commitAll, commitRawPath, snapshot, fakeSystemd, writeConfig, localConfig, run, git, SKIP_NO_BASH } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deployId } from '../lib/plan.mjs';
import { LocalBashTransport } from '../lib/transport.mjs';

const NASTY = {
    'a b.txt': 'space\n',
    "it's.txt": 'quote\n',
    '$(touch pwned).txt': 'subshell\n',
    '`touch pwned2`.txt': 'backticks\n',
    'semi;colon&amp.txt': 'meta\n',
    '-leading-dash.txt': 'dash\n',
    '#@CUR': 'looks like a marker\n',
    'dir with space/nested/deep.js': 'export const x = 1;\n',
    'ünïcödé/файл.txt': 'utf8\n',
    ['long-' + 'x'.repeat(120) + '/name-' + 'y'.repeat(60) + '.txt']: 'long path\n'
};

function setup(files = NASTY, targetExtra = {}, extra = {}) {
    const repo = makeRepo({ 'index.html': '<h1>v1</h1>\n', 'lib/app.js': 'console.log(1);\r\n', ...files });
    const server = tmpDir('vd-server-');
    const cfgDir = tmpDir('vd-cfg-');
    writeConfig(cfgDir, localConfig(server, { site: { repo, remoteDir: 'apps/site', ...targetExtra } }, extra));
    return { repo, server, cfgDir, site: path.join(server, 'apps', 'site') };
}

test('plan lists every file, changes nothing on the server', { skip: SKIP_NO_BASH }, async () => {
    const { server, cfgDir } = setup();
    const r = await run(['plan', 'site'], { cwd: cfgDir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /site -> apps\/site .*never deployed/);
    assert.match(r.out, /\+12 ~0 -0/);
    assert.match(r.out, /\+ a b\.txt/);
    assert.match(r.out, /\+ \$\(touch pwned\)\.txt/);
    assert.match(r.out, /does not exist on the server yet/);
    assert.match(r.out, /dry-run: nothing was changed/);
    assert.deepEqual(fs.readdirSync(server), [], 'plan must not create anything');
    const again = await run(['apply', 'site'], { cwd: cfgDir });
    assert.equal(again.code, 0);
    assert.match(again.out, /Add --apply to deploy/);
    assert.deepEqual(fs.readdirSync(server), [], 'apply without --apply is a dry-run');
    assert.equal((await run(['plan', 'site', '--apply'], { cwd: cfgDir })).code, 2);
});

test('apply sends exact blob bytes, verifies hashes, records state; nasty names never execute', { skip: SKIP_NO_BASH }, async () => {
    const { repo, server, cfgDir, site } = setup();
    git(repo, 'update-index', '--chmod=+x', 'lib/app.js');
    git(repo, 'commit', '-q', '-m', 'exec bit');
    const r = await run(['apply', 'site', '--apply'], { cwd: cfgDir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /ok site +sent 12, deleted 0, hashes verified/);
    for (const [p, content] of Object.entries(NASTY)) assert.equal(fs.readFileSync(path.join(site, ...p.split('/')), 'utf8'), content, p);
    assert.equal(fs.readFileSync(path.join(site, 'lib', 'app.js'), 'utf8'), 'console.log(1);\r\n', 'CRLF kept byte for byte');
    for (const dir of [server, site, process.cwd(), cfgDir, repo]) {
        assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'command substitution ran in ' + dir);
        assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false, 'backticks ran in ' + dir);
    }
    const state = fs.readFileSync(path.join(server, '.deploy', 'state', 'site.state'), 'utf8').trim().split('\n');
    const meta = JSON.parse(state[0]);
    assert.equal(meta.head, git(repo, 'rev-parse', 'HEAD').trim());
    assert.equal(state.length, 13);
    const second = await run(['plan', 'site'], { cwd: cfgDir });
    assert.match(second.out, /up to date/);
    assert.match(second.out, /Nothing to deploy/);
});

test('update + delete + add, then rollback restores the exact previous tree', { skip: SKIP_NO_BASH }, async () => {
    const { repo, server, cfgDir, site } = setup({ 'keep.txt': 'keep\n', 'old/gone.txt': 'gone\n', "it's.txt": 'v1\n' });
    let r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 0, 1, 10, 0, 0) });
    assert.equal(r.code, 0, r.all);
    const before = snapshot(server);
    commitAll(repo, { "it's.txt": 'v2\n', 'old/gone.txt': null, 'new/dir/$(x) added.txt': 'new\n', 'index.html': '<h1>v2</h1>\n' });
    r = await run(['plan', 'site'], { cwd: cfgDir });
    assert.match(r.out, /\+1 ~2 -1/);
    assert.match(r.out, /- old\/gone\.txt/);
    r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 0, 2, 10, 0, 0) });
    assert.equal(r.code, 0, r.all);
    const id = '20260102-100000';
    assert.match(r.out, new RegExp('deploy ' + id));
    assert.equal(fs.readFileSync(path.join(site, "it's.txt"), 'utf8'), 'v2\n');
    assert.equal(fs.existsSync(path.join(site, 'old', 'gone.txt')), false);
    assert.equal(fs.readFileSync(path.join(site, 'new', 'dir', '$(x) added.txt'), 'utf8'), 'new\n');

    const dry = await run(['rollback', id], { cwd: cfgDir });
    assert.equal(dry.code, 0, dry.all);
    assert.match(dry.out, /restore 3, delete 1 created file\(s\) and up to 2 created folder/);
    assert.match(dry.out, /< old\/gone\.txt/);
    assert.match(dry.out, /- new\/dir\/\$\(x\) added\.txt/);
    assert.match(dry.out, /dry-run/);
    assert.equal(fs.readFileSync(path.join(site, "it's.txt"), 'utf8'), 'v2\n', 'rollback dry-run changes nothing');

    const rb = await run(['rollback', id, '--apply'], { cwd: cfgDir });
    assert.equal(rb.code, 0, rb.all);
    assert.deepEqual(snapshot(server), before, 'tree, created folders and deploy record are back to the state before ' + id);
    const again = await run(['rollback', id, '--apply'], { cwd: cfgDir });
    assert.equal(again.code, 1);
    assert.match(again.err, /already rolled back/);
});

test('rollback of a first deploy removes everything it created, including folders and the record', { skip: SKIP_NO_BASH }, async () => {
    const { server, cfgDir } = setup({ 'x/y/z.txt': 'z\n' });
    const before = snapshot(server);
    const r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 1, 1) });
    assert.equal(r.code, 0, r.all);
    const rb = await run(['rollback', '20260201-000000', '--apply'], { cwd: cfgDir });
    assert.equal(rb.code, 0, rb.all);
    const after = snapshot(server);
    assert.deepEqual(after.files, before.files);
    assert.deepEqual(after.dirs.filter((d) => !d.startsWith('.deploy')), [], 'apps/ and apps/site/ were created by the deploy and are gone');
});

test('rollback refuses an older deploy when a newer one touched the same target (unless --force)', { skip: SKIP_NO_BASH }, async () => {
    const { repo, cfgDir } = setup({ 'f.txt': '1\n' });
    await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 2, 1) });
    commitAll(repo, { 'f.txt': '2\n' });
    await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 2, 2) });
    const r = await run(['rollback', '20260301-000000', '--apply'], { cwd: cfgDir });
    assert.equal(r.code, 1);
    assert.match(r.err, /deployed again after 20260301-000000: site \(current deploy: 20260302-000000\)/);
});

test('two deploys in the same second get distinct ids', { skip: SKIP_NO_BASH }, async () => {
    const { repo, server, cfgDir } = setup({ 'f.txt': '1\n' });
    const now = () => Date.UTC(2026, 3, 1, 12, 0, 0);
    assert.equal((await run(['apply', 'site', '--apply'], { cwd: cfgDir, now })).code, 0);
    commitAll(repo, { 'f.txt': '2\n' });
    const r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, now });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /deploy 20260401-120000-2/);
    assert.deepEqual(fs.readdirSync(path.join(server, '.deploy', 'backups')).sort(), ['20260401-120000', '20260401-120000-2']);
});

test('drift: a file edited on the server stops --apply unless --force (and is backed up)', { skip: SKIP_NO_BASH }, async () => {
    const { repo, cfgDir, site } = setup({ 'conf.txt': 'a\n' });
    await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => Date.UTC(2026, 4, 1) });
    fs.writeFileSync(path.join(site, 'conf.txt'), 'edited on the server\n');
    commitAll(repo, { 'conf.txt': 'b\n' });
    const plan = await run(['plan', 'site'], { cwd: cfgDir });
    assert.match(plan.out, /~ conf\.txt +<- changed on the server \(drift\)/);
    assert.match(plan.err, /--apply would stop/);
    const refused = await run(['apply', 'site', '--apply'], { cwd: cfgDir });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /drift/);
    assert.equal(fs.readFileSync(path.join(site, 'conf.txt'), 'utf8'), 'edited on the server\n');
    const forced = await run(['apply', 'site', '--apply', '--force'], { cwd: cfgDir, now: () => Date.UTC(2026, 4, 2) });
    assert.equal(forced.code, 0, forced.all);
    assert.equal(fs.readFileSync(path.join(site, 'conf.txt'), 'utf8'), 'b\n');
    await run(['rollback', '20260502-000000', '--apply'], { cwd: cfgDir });
    assert.equal(fs.readFileSync(path.join(site, 'conf.txt'), 'utf8'), 'edited on the server\n', 'the server edit comes back on rollback');
});

test('dirty work tree: --apply refuses; --allow-dirty deploys HEAD, not the edit', { skip: SKIP_NO_BASH }, async () => {
    const { repo, cfgDir, site } = setup({ 'f.txt': 'committed\n' });
    fs.writeFileSync(path.join(repo, 'f.txt'), 'uncommitted\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const plan = await run(['plan', 'site'], { cwd: cfgDir });
    assert.match(plan.out, /2 uncommitted change/);
    const refused = await run(['apply', 'site', '--apply'], { cwd: cfgDir });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /uncommitted changes in site/);
    assert.equal(fs.existsSync(site), false);
    const ok = await run(['apply', 'site', '--apply', '--allow-dirty'], { cwd: cfgDir });
    assert.equal(ok.code, 0, ok.all);
    assert.equal(fs.readFileSync(path.join(site, 'f.txt'), 'utf8'), 'committed\n');
    assert.equal(fs.existsSync(path.join(site, '.env')), false, 'untracked files never leave the machine');
});

test('file names that cannot be carried safely (newline, backslash, control chars) are rejected', { skip: SKIP_NO_BASH }, async () => {
    for (const bad of ['evil\nname.txt', 'tab\there.txt', 'back\\slash.txt', 'trailing /x.txt']) {
        const { repo, server, cfgDir } = setup({ 'ok.txt': 'ok\n' });
        commitRawPath(repo, bad, 'x\n');
        const r = await run(['plan', 'site'], { cwd: cfgDir });
        assert.equal(r.code, 1, JSON.stringify(bad) + ': ' + r.all);
        assert.match(r.err, /cannot be deployed safely/);
        assert.deepEqual(fs.readdirSync(server), []);
        // excluding the file makes the target deployable again
        const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'deploy.config.json'), 'utf8'));
        cfg.targets.site.exclude = [bad.split('/')[0].includes(' ') ? 'trailing */**' : '*[\t\n\\\\]*'];
        writeConfig(cfgDir, cfg);
        const ok = await run(['plan', 'site'], { cwd: cfgDir });
        assert.equal(ok.code, 0, JSON.stringify(bad) + ' excluded: ' + ok.all);
    }
});

test('include / exclude globs pick what is deployed; excluded files are removed when previously deployed', { skip: SKIP_NO_BASH }, async () => {
    const { cfgDir, site } = setup({ 'README.md': '# r\n', 'docs/a.md': 'a\n', 'test/t.js': 't\n', 'src/main.js': 'm\n' }, { exclude: ['test/**', '**/*.md'] });
    const r = await run(['apply', 'site', '--apply'], { cwd: cfgDir });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.existsSync(path.join(site, 'src', 'main.js')), true);
    for (const p of ['README.md', 'docs/a.md', 'test/t.js']) assert.equal(fs.existsSync(path.join(site, p)), false, p);
});

test('prune deletes only deploy-id folders older than keepDays and keeps the newest keepMin', { skip: SKIP_NO_BASH }, async () => {
    const { server, cfgDir } = setup({ 'f.txt': '1\n' }, {}, { backups: { keepDays: 14, keepMin: 2 } });
    const bk = path.join(server, '.deploy', 'backups');
    const now = Date.UTC(2026, 5, 30);
    for (const days of [100, 60, 30, 20]) fs.mkdirSync(path.join(bk, deployId(now - days * 86400000)), { recursive: true });
    fs.mkdirSync(path.join(bk, 'not-a-deploy-id'), { recursive: true });
    const dry = await run(['prune'], { cwd: cfgDir, now: () => now });
    assert.equal(dry.code, 0, dry.all);
    assert.match(dry.out, /would prune 2 backup/);
    assert.equal(fs.readdirSync(bk).length, 5);
    const r = await run(['prune', '--apply'], { cwd: cfgDir, now: () => now });
    assert.equal(r.code, 0, r.all);
    assert.deepEqual(fs.readdirSync(bk).sort(), [deployId(now - 30 * 86400000), deployId(now - 20 * 86400000), 'not-a-deploy-id'].sort());
    // a deploy prunes too, and never its own backup
    const a = await run(['apply', 'site', '--apply'], { cwd: cfgDir, now: () => now });
    assert.equal(a.code, 0, a.all);
    assert.match(a.out, /pruned 1 backup/);
    assert.deepEqual(fs.readdirSync(bk).sort(), [deployId(now - 20 * 86400000), deployId(now), 'not-a-deploy-id'].sort());
});

test('restart: affected units restarted (last ones after), health checked, failure reported with rollback id', { skip: SKIP_NO_BASH }, async () => {
    const systemd = fakeSystemd();
    const repo = makeRepo({ 'a.txt': '1\n' });
    const repo2 = makeRepo({ 'b.txt': '1\n' });
    const server = tmpDir('vd-server-');
    const cfgDir = tmpDir('vd-cfg-');
    const health = http.createServer((req, res) => { res.statusCode = req.url === '/ok' ? 200 : 503; res.end(); });
    await new Promise((r) => health.listen(0, '127.0.0.1', r));
    const port = health.address().port;
    try {
        writeConfig(cfgDir, localConfig(server, {
            app: { repo, remoteDir: 'app', units: ['app.service', 'proxy.service'], health: 'http://127.0.0.1:' + port + '/ok' },
            other: { repo: repo2, remoteDir: 'other', units: ['other.service'] }
        }, { restart: { mode: 'user', timeoutSec: 3, last: ['proxy.service'] } }));
        const plan = await run(['plan', 'all'], { cwd: cfgDir, systemd });
        assert.match(plan.out, /restart: app\.service, other\.service, proxy\.service/);
        let r = await run(['apply', 'app', '--apply'], { cwd: cfgDir, systemd });
        assert.equal(r.code, 0, r.all);
        assert.deepEqual(systemd.restarts(), ['app.service', 'proxy.service'], 'only affected units; proxy (last) after app');
        assert.match(r.out, /up app\.service/);

        // health failing -> deploy reports the failure and how to roll back
        const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'deploy.config.json'), 'utf8'));
        cfg.targets.other.health = 'http://127.0.0.1:' + port + '/down';
        writeConfig(cfgDir, cfg);
        r = await run(['apply', 'other', '--apply'], { cwd: cfgDir, systemd, now: () => Date.UTC(2026, 6, 1) });
        assert.equal(r.code, 1);
        assert.match(r.err, /down other\.service/);
        assert.match(r.err, /restart failed: other\.service\nRoll back with: vanilla-deploy rollback 20260701-000000 --apply/);

        // --no-restart skips; `restart` is a dry-run without --apply
        commitAll(repo, { 'a.txt': '2\n' });
        const before = systemd.restarts().length;
        r = await run(['apply', 'app', '--apply', '--no-restart'], { cwd: cfgDir, systemd });
        assert.equal(r.code, 0, r.all);
        assert.equal(systemd.restarts().length, before);
        r = await run(['restart', 'app'], { cwd: cfgDir, systemd });
        assert.match(r.out, /dry-run: would restart app\.service, proxy\.service/);
        assert.equal(systemd.restarts().length, before);
        const list = await run(['list'], { cwd: cfgDir, systemd });
        assert.equal(list.code, 0, list.all);
        assert.match(list.out, /app -> app +units: app\.service, proxy\.service +deployed/);
        assert.match(list.out, /\* app\.service active/);
        assert.match(list.out, /20260701-000000 +other/);
    } finally {
        health.close();
    }
});

test('cache purge: skipped when unconfigured or env missing; batched URL purge with the token kept out of logs', { skip: SKIP_NO_BASH }, async () => {
    const files = { 'public/a b.css': 'a\n', 'public/x/y.js': 'y\n', 'server/main.js': 's\n' };
    const target = { cache: { include: ['public/**'], stripPrefix: 'public/' } };
    // 1) no cloudflare section
    let s = setup(files, target);
    let r = await run(['apply', 'site', '--apply'], { cwd: s.cfgDir });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /cache purge skipped \(not configured\) - 2 cached file\(s\) changed/);

    // 2) configured, env missing
    const requests = [];
    const api = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
            res.setHeader('Content-Type', 'application/json');
            const fail = requests.length > 2;
            res.end(JSON.stringify(fail ? { success: false, errors: [{ message: 'bad token tok-SECRET-123456' }] } : { success: true }));
        });
    });
    await new Promise((res) => api.listen(0, '127.0.0.1', res));
    const apiBase = 'http://127.0.0.1:' + api.address().port + '/client/v4';
    const zone = 'ab'.repeat(16);
    try {
        s = setup(files, target, { cloudflare: { urlPrefix: 'https://www.example.com/', apiBase, batchSize: 1 } });
        r = await run(['apply', 'site', '--apply'], { cwd: s.cfgDir, env: {} });
        assert.match(r.out, /cache purge skipped \(CLOUDFLARE_API_TOKEN is not set\)/);
        assert.equal(requests.length, 0);

        // 3) configured + env -> two requests (batchSize 1), URL-encoded, prefix stripped
        commitAll(s.repo, { 'public/a b.css': 'a2\n', 'public/x/y.js': 'y2\n' });
        const env = { CLOUDFLARE_API_TOKEN: 'tok-SECRET-123456', CLOUDFLARE_ZONE_ID: zone };
        r = await run(['apply', 'site', '--apply'], { cwd: s.cfgDir, env });
        assert.equal(r.code, 0, r.all);
        assert.match(r.out, /cache purged \(2 URL/);
        assert.deepEqual(requests.map((q) => q.body.files[0]).sort(), ['https://www.example.com/a%20b.css', 'https://www.example.com/x/y.js']);
        assert.equal(requests[0].url, '/client/v4/zones/' + zone + '/purge_cache');
        assert.equal(requests[0].auth, 'Bearer tok-SECRET-123456');

        // 4) API error: reported, token redacted, deploy still succeeds; --no-purge skips
        commitAll(s.repo, { 'public/a b.css': 'a3\n' });
        r = await run(['apply', 'site', '--apply'], { cwd: s.cfgDir, env });
        assert.equal(r.code, 0, r.all);
        assert.match(r.out, /cache purge failed: bad token \*\*\*/);
        assert.doesNotMatch(r.all, /tok-SECRET-123456/);
        commitAll(s.repo, { 'public/a b.css': 'a4\n' });
        const n = requests.length;
        r = await run(['apply', 'site', '--apply', '--no-purge'], { cwd: s.cfgDir, env });
        assert.match(r.out, /cache purge skipped \(--no-purge\)/);
        assert.equal(requests.length, n);
    } finally {
        api.close();
    }
});

test('servers without git: the sha1sum fallback hashes exactly like git', { skip: SKIP_NO_BASH }, async () => {
    const { cfgDir } = setup();
    const transport = new LocalBashTransport({ env: { VD_HASH_SHA1SUM: '1' } });
    const r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, transport });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /hashes verified/);
    const again = await run(['plan', 'site'], { cwd: cfgDir, transport });
    assert.match(again.out, /up to date +same 12/);
});

test('the bin runs as a process', { skip: SKIP_NO_BASH }, () => {
    const { cfgDir } = setup({ 'f.txt': '1\n' });
    const bin = fileURLToPath(new URL('../bin/vanilla-deploy.mjs', import.meta.url));
    const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    assert.equal(v.stdout.trim(), '0.1.0');
    const p = spawnSync(process.execPath, [bin, 'plan', 'all'], { cwd: cfgDir, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /\+3 ~0 -0/);
    const bad = spawnSync(process.execPath, [bin, 'apply', 'missing-target'], { cwd: cfgDir, encoding: 'utf8' });
    assert.equal(bad.status, 2);
});

test('usage and config errors exit 2', { skip: SKIP_NO_BASH }, async () => {
    const { cfgDir } = setup({ 'f.txt': '1\n' });
    assert.equal((await run(['bogus'], { cwd: cfgDir })).code, 2);
    assert.equal((await run(['apply'], { cwd: cfgDir })).code, 2);
    assert.equal((await run(['apply', 'nope'], { cwd: cfgDir })).code, 2);
    assert.equal((await run(['rollback', '../../etc'], { cwd: cfgDir })).code, 2);
    assert.equal((await run(['plan', 'site', '--yes'], { cwd: cfgDir })).code, 2);
    assert.equal((await run(['list'], { cwd: tmpDir() })).code, 2, 'no config');
    assert.equal((await run(['--version'], { cwd: cfgDir })).out, '0.1.0');
});
