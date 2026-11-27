// Pure parts: change calculation, deploy ids, pruning, chunking, cache URLs, config validation, script parsers,
// Cloudflare auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffPlan, changeCount, newDirCandidates, deepestFirst, deployId, idTime, backupsToPrune, chunkBySize, cacheUrl } from '../lib/plan.mjs';
import { normalizeConfig, loadConfig, ConfigError } from '../lib/config.mjs';
import { sections, pairs, parseInfo, parseState, stateText, parseFinalize, parseRestart, rawLines, prelude } from '../lib/scripts.mjs';
import { cloudflareAuth, redact, purgeCache } from '../lib/cloudflare.mjs';
import { affectedUnits, parseArgs, UsageError } from '../lib/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = { name: 'site', remoteDir: 'site' };
const f = (sha) => ({ sha, mode: '100644', size: 1 });

test('diffPlan: add / update / remove / same; drift only where the server differs from the last deploy', () => {
    const info = {
        mode: 'present',
        state: { meta: { deploy_id: 'x' }, files: { 'same.txt': 's1', 'upd.txt': 'u1', 'gone.txt': 'g1', 'edited.txt': 'e1', 'edited-gone.txt': 'eg1' } },
        cur: { 'same.txt': 's1', 'upd.txt': 'u1', 'gone.txt': 'g1', 'edited.txt': 'SERVER', 'edited-gone.txt': 'SERVER', 'unmanaged.txt': 'zz', 'foreign.txt': 'ff' }
    };
    const local = { head: 'h', files: { 'same.txt': f('s1'), 'upd.txt': f('u2'), 'new.txt': f('n1'), 'edited.txt': f('e2'), 'foreign.txt': f('f2') } };
    const p = diffPlan(T, local, info);
    assert.deepEqual(p.add, ['new.txt']);
    assert.deepEqual(p.update, ['edited.txt', 'foreign.txt', 'upd.txt']);
    assert.deepEqual(p.remove, ['edited-gone.txt', 'gone.txt']);
    assert.deepEqual(p.drift, ['edited-gone.txt', 'edited.txt', 'foreign.txt'], 'server edits and files never deployed by us');
    assert.equal(p.same, 1);
    assert.equal(changeCount(p), 6);
    assert.ok(!p.remove.includes('unmanaged.txt'), 'files this tool never deployed are left alone');
});

test('diffPlan: first deploy into a missing folder is all adds, no drift', () => {
    const p = diffPlan(T, { head: 'h', files: { 'a': f('1'), 'b/c': f('2') } }, { mode: 'missing', state: null, cur: {} });
    assert.deepEqual([p.add, p.update, p.remove, p.drift], [['a', 'b/c'], [], [], []]);
});

test('new folder candidates and deepest-first order', () => {
    assert.deepEqual(newDirCandidates('apps/site', ['x/y/z.txt', 'top.txt']), ['apps', 'apps/site', 'apps/site/x', 'apps/site/x/y']);
    assert.deepEqual(deepestFirst(['a', 'a/b', 'a/b/c', 'z']), ['a/b/c', 'a/b', 'z', 'a']);
});

test('deploy ids are UTC timestamps; pruning keeps the newest keepMin, the current one, and foreign names', () => {
    const now = Date.UTC(2026, 10, 27, 9, 8, 7);
    assert.equal(deployId(now), '20261127-090807');
    assert.equal(idTime('20261127-090807'), now);
    assert.equal(idTime('20261127-090807-2'), now);
    assert.ok(Number.isNaN(idTime('20261127-0908')));
    assert.ok(Number.isNaN(idTime('../20261127-090807')));
    const day = 86400000;
    const names = [deployId(now - 40 * day), deployId(now - 30 * day), deployId(now - 20 * day), deployId(now - 10 * day), deployId(now - day), 'manual-copy', 'notes.txt'];
    assert.deepEqual(backupsToPrune(names, { now, keepDays: 14, keepMin: 2 }), names.slice(0, 3));
    assert.deepEqual(backupsToPrune(names, { now, keepDays: 14, keepMin: 4 }), names.slice(0, 1));
    assert.deepEqual(backupsToPrune(names, { now, keepDays: 14, keepMin: 0, keepId: names[0] }), names.slice(1, 3));
    assert.deepEqual(backupsToPrune([], { now }), []);
});

test('chunking by size and cache URLs', () => {
    const sizes = { a: 10, b: 10, c: 5000, d: 1 };
    assert.deepEqual(chunkBySize(['a', 'b', 'c', 'd'], (p) => sizes[p], 3000), [['a', 'b'], ['c'], ['d']]);
    assert.deepEqual(chunkBySize([], () => 1), []);
    assert.equal(cacheUrl('https://www.example.com/', 'public/', 'public/a b/c#d.css'), 'https://www.example.com/a%20b/c%23d.css');
    assert.equal(cacheUrl('https://www.example.com/', '', 'x.js'), 'https://www.example.com/x.js');
});

test('example config is valid; paths resolve relative to the config folder', async () => {
    const c = await loadConfig(path.join(ROOT, 'deploy.config.example.json'));
    assert.equal(c.ssh.host, '203.0.113.10');
    assert.equal(c.ssh.port, 22);
    assert.equal(c.targets.api.repo, path.resolve(ROOT, '../example-api'));
    assert.equal(c.restart.mode, 'user');
    assert.deepEqual(affectedUnits(c, [c.targets.proxy, c.targets.api]).map((g) => g.map((u) => u.unit)), [['example-api.service'], ['example-proxy.service']]);
    assert.equal(c.cloudflare.batchSize, 30);
});

test('config validation rejects unsafe or mistyped values', () => {
    const base = () => ({ ssh: { host: 'example.com', user: 'deploy', key: '~/.ssh/k' }, remoteRoot: '/srv/app', targets: { web: { repo: '.', remoteDir: 'web' } } });
    assert.ok(normalizeConfig(base(), '/tmp'));
    const bad = [
        ['unknown top-level key', (c) => { c.remotRoot = '/x'; }],
        ['unknown target key', (c) => { c.targets.web.unit = ['x']; }],
        ['remoteDir with ..', (c) => { c.targets.web.remoteDir = '../etc'; }],
        ['absolute remoteDir', (c) => { c.targets.web.remoteDir = '/etc'; }],
        ['remoteDir in .deploy', (c) => { c.targets.web.remoteDir = '.deploy'; }],
        ['relative remoteRoot', (c) => { c.remoteRoot = 'srv'; }],
        ['root remoteRoot', (c) => { c.remoteRoot = '/'; }],
        ['remoteRoot with ..', (c) => { c.remoteRoot = '/srv/../etc'; }],
        ['host starting with -', (c) => { c.ssh.host = '-oProxyCommand=x'; }],
        ['user with @', (c) => { c.ssh.user = 'a@b'; }],
        ['bad port', (c) => { c.ssh.port = 70000; }],
        ['host key checking off', (c) => { c.ssh.strictHostKeyChecking = 'no'; }],
        ['unit with space', (c) => { c.targets.web.units = ['a b.service']; }],
        ['unit with ;', (c) => { c.targets.web.units = ['a;reboot']; }],
        ['health with quote', (c) => { c.targets.web.health = "http://x/'"; }],
        ['health not http', (c) => { c.targets.web.health = 'file:///etc/passwd'; }],
        ['reserved target name', (c) => { c.targets.all = { repo: '.', remoteDir: 'all' }; }],
        ['overlapping remoteDir', (c) => { c.targets.api = { repo: '.', remoteDir: 'web/api' }; }],
        ['restart mode', (c) => { c.restart = { mode: 'reboot' }; }],
        ['cloudflare token in config', (c) => { c.cloudflare = { token: 'abc' }; }],
        ['cloudflare env name', (c) => { c.cloudflare = { tokenEnv: 'not a name' }; }],
        ['missing ssh', (c) => { delete c.ssh; }],
        ['no targets', (c) => { c.targets = {}; }]
    ];
    for (const [what, mutate] of bad) {
        const c = base();
        mutate(c);
        assert.throws(() => normalizeConfig(c, '/tmp'), ConfigError, what);
    }
    const local = base();
    delete local.ssh;
    local.transport = { type: 'local' };
    assert.equal(normalizeConfig(local, '/tmp').ssh, null, 'local transport needs no ssh section');
});

test('script output parsers', () => {
    const s = sections('junk\n#@MODE\npresent\n#@STATE\n{"deploy_id":"1"}\nabc a b.txt\n\n#@CUR\nabc a b.txt\ndef #@x\n');
    assert.deepEqual(s.MODE, ['present']);
    assert.deepEqual(pairs(s.CUR), { 'a b.txt': 'abc', '#@x': 'def' });
    assert.throws(() => pairs(['abc ../../etc/passwd']), /segment/, 'tampered records cannot smuggle paths');
    const info = parseInfo('#@MODE\npresent\n#@STATE\n{"deploy_id":"1"}\nabc a b.txt\n#@CUR\n');
    assert.equal(info.state.meta.deploy_id, '1');
    assert.deepEqual(info.state.files, { 'a b.txt': 'abc' });
    assert.throws(() => parseInfo('garbage'), /MODE/);
    assert.equal(parseState([]), null);
    assert.deepEqual(stateText({ a: 1 }, { 'b.txt': '2', 'a.txt': '1' }), ['{"a":1}', '1 a.txt', '2 b.txt']);
    assert.deepEqual(rawLines(['=a', '=#@MODE', 'b']), ['a', '#@MODE']);
    assert.deepEqual(parseFinalize('#@LEFT\n#@VERIFY 0\n', ['1 a']), { ok: true, mismatched: [], left: [] });
    assert.deepEqual(parseFinalize('#@GOT\n9 a\n#@LEFT\n=old.txt\n#@VERIFY 1\n', ['1 a', '2 b']), { ok: false, mismatched: ['a', 'b'], left: ['old.txt'] });
    assert.deepEqual(parseRestart('UP a.service 3\nDOWN b.service failed\n'), { up: [{ unit: 'a.service', seconds: 3 }], down: [{ unit: 'b.service', state: 'failed' }] });
    assert.match(prelude('/srv/x', { mode: 'user' }), /SC=\(systemctl --user\)/);
    assert.match(prelude('/srv/x', { mode: 'system', sudo: true }), /SC=\(sudo -n systemctl\)/);
    assert.doesNotMatch(prelude('/srv/x', { mode: 'none' }), /SC=/);
    assert.match(prelude("/srv/it's", { mode: 'none' }), /R='\/srv\/it'\\''s'/);
});

test('cloudflare: off unless configured and both env values present; token never in error text', async () => {
    const cf = { tokenEnv: 'CF_T', zoneEnv: 'CF_Z', urlPrefix: null, apiBase: 'http://127.0.0.1:9', batchSize: 30 };
    assert.deepEqual(cloudflareAuth(null, {}), { ok: false, configured: false, why: 'not configured' });
    assert.match(cloudflareAuth(cf, {}).why, /CF_T is not set/);
    assert.match(cloudflareAuth(cf, { CF_T: 'secret-token-value' }).why, /CF_Z/);
    assert.match(cloudflareAuth(cf, { CF_T: 'secret-token-value', CF_Z: 'nothex' }).why, /32-character/);
    const auth = cloudflareAuth(cf, { CF_T: 'secret-token-value', CF_Z: 'a'.repeat(32) });
    assert.equal(auth.ok, true);
    assert.equal(redact('x secret-token-value y', ['secret-token-value']), 'x *** y');
    const r = await purgeCache(cf, auth, null, { fetchImpl: async () => { throw new Error('connect failed with secret-token-value'); } });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.why, /secret-token-value/);
    const bodies = [];
    const ok = await purgeCache({ ...cf, batchSize: 2 }, auth, ['u1', 'u2', 'u3'], { fetchImpl: async (url, o) => { bodies.push(JSON.parse(o.body)); return { status: 200, text: async () => '{"success":true}' }; } });
    assert.deepEqual([ok.ok, ok.requests], [true, 2]);
    assert.deepEqual(bodies, [{ files: ['u1', 'u2'] }, { files: ['u3'] }]);
});

test('argument parsing', () => {
    assert.deepEqual(parseArgs(['apply', 'a', 'b', '--apply', '--config', 'x.json']), { command: 'apply', args: ['a', 'b'], flags: new Set(['--apply']), config: 'x.json' });
    assert.equal(parseArgs(['list', '--config=y.json']).config, 'y.json');
    assert.throws(() => parseArgs(['apply', '--aply']), UsageError);
    assert.throws(() => parseArgs(['apply', '--config']), UsageError);
});
