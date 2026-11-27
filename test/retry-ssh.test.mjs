// SSH retry policy (pre-auth drops only) and the ssh transport, including a full deploy through a fake ssh
// that drops the first connections like a busy sshd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isPreAuthDrop, backoffMs, withRetry } from '../lib/retry.mjs';
import { SshTransport, runScript } from '../lib/transport.mjs';
import { HERE, BASH, SKIP_NO_BASH, tmpDir, makeRepo, writeConfig, run, commitAll } from './helpers.mjs';
import { toBashPath } from '../lib/paths.mjs';

const KEX = 'kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 203.0.113.10 port 22';

test('classifier: only exit 255 with a pre-key-exchange message counts', () => {
    assert.equal(isPreAuthDrop(255, KEX), true);
    assert.equal(isPreAuthDrop(255, 'ssh_exchange_identification: Connection closed by remote host'), true);
    assert.equal(isPreAuthDrop(255, 'Connection closed by 203.0.113.10 port 22 during banner exchange'), true);
    assert.equal(isPreAuthDrop(255, 'Connection to 203.0.113.10 closed by remote host.'), false, 'mid-command drop');
    assert.equal(isPreAuthDrop(255, 'Permission denied (publickey).'), false);
    assert.equal(isPreAuthDrop(255, 'Connection refused'), false);
    assert.equal(isPreAuthDrop(1, KEX), false, 'a remote command that prints the text is not a drop');
    assert.equal(isPreAuthDrop(0, KEX), false);
    assert.equal(isPreAuthDrop(255, ''), false);
});

test('backoff: exponential, capped at 8s, jitter below 400ms', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((i) => backoffMs(i, () => 0)), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
    assert.equal(backoffMs(1, () => 0.999), 899);
});

test('withRetry: retries retryable errors up to the limit, never others', async () => {
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    let n = 0;
    const r = await withRetry(async () => { n++; if (n < 3) { const e = new Error('drop'); e.preAuth = true; throw e; } return 'ok'; }, { attempts: 5, sleep, random: () => 0 });
    assert.equal(r, 'ok');
    assert.equal(n, 3);
    assert.deepEqual(waits, [500, 1000]);

    n = 0;
    await assert.rejects(withRetry(async () => { n++; throw new Error('mid-command'); }, { attempts: 5, sleep }), /mid-command/);
    assert.equal(n, 1, 'non-retryable: exactly one attempt');

    n = 0;
    await assert.rejects(withRetry(async () => { n++; const e = new Error('drop'); e.preAuth = true; throw e; }, { attempts: 4, sleep }), /drop/);
    assert.equal(n, 4, 'gives up after `attempts`');
});

const SSH = { host: '203.0.113.10', port: 2222, user: 'deploy', key: '/keys/id_ed25519', command: 'ssh', connectTimeout: 15, strictHostKeyChecking: 'accept-new', knownHostsFile: null, retries: 5 };

test('ssh arguments: -F none, explicit key and port, batch mode, destination after --', () => {
    const a = new SshTransport(SSH).args('bash -s');
    assert.deepEqual(a.slice(0, 6), ['-F', 'none', '-p', '2222', '-i', '/keys/id_ed25519']);
    for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=accept-new', 'ConnectTimeout=15']) assert.ok(a.includes(o), o);
    assert.deepEqual(a.slice(-3), ['--', 'deploy@203.0.113.10', 'bash -s']);
});

function fakeSpawn(env) {
    return (cmd, args, opts) => spawn(process.execPath, [path.join(HERE, 'fixtures', 'fake-ssh.mjs'), ...args], { ...opts, env: { ...process.env, FAKE_SSH_BASH: BASH, ...env } });
}

test('ssh transport retries pre-auth drops, then runs the command', { skip: SKIP_NO_BASH }, async () => {
    const dir = tmpDir('vd-ssh-');
    const drops = path.join(dir, 'drops'), log = path.join(dir, 'log');
    fs.writeFileSync(drops, '2');
    const retries = [];
    const t = new SshTransport(SSH, { spawnImpl: fakeSpawn({ FAKE_SSH_DROPS: drops, FAKE_SSH_LOG: log }), sleep: async () => {}, onRetry: (e, i) => retries.push(i) });
    const out = await runScript(t, 'echo "hello $((40 + 2))"\n');
    assert.equal(out, 'hello 42\n');
    assert.deepEqual(retries, [1, 2]);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);
});

test('ssh transport never retries a connection lost mid-command', { skip: SKIP_NO_BASH }, async () => {
    const dir = tmpDir('vd-ssh-');
    const log = path.join(dir, 'log');
    const t = new SshTransport(SSH, { spawnImpl: fakeSpawn({ FAKE_SSH_MIDCOMMAND: '1', FAKE_SSH_LOG: log }), sleep: async () => {} });
    await assert.rejects(runScript(t, 'echo hi\n'), /exit 255.*closed by remote host/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'exactly one attempt');
});

test('ssh transport gives up after ssh.retries pre-auth drops', { skip: SKIP_NO_BASH }, async () => {
    const dir = tmpDir('vd-ssh-');
    const drops = path.join(dir, 'drops'), log = path.join(dir, 'log');
    fs.writeFileSync(drops, '100');
    const t = new SshTransport({ ...SSH, retries: 3 }, { spawnImpl: fakeSpawn({ FAKE_SSH_DROPS: drops, FAKE_SSH_LOG: log }), sleep: async () => {} });
    await assert.rejects(runScript(t, 'echo hi\n'), /exit 255.*kex_exchange_identification/);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 3);
});

test('full deploy + rollback through the ssh transport with flaky pre-auth drops', { skip: SKIP_NO_BASH }, async () => {
    const repo = makeRepo({ 'a b.txt': 'one\n', 'lib/x.js': 'x\n' });
    const server = tmpDir('vd-server-');
    const cfgDir = tmpDir('vd-cfg-');
    writeConfig(cfgDir, { ssh: { host: '203.0.113.10', user: 'deploy', key: '~/.ssh/id_test' }, remoteRoot: toBashPath(server), restart: { mode: 'none' }, targets: { site: { repo, remoteDir: 'site' } } });
    const drops = path.join(tmpDir('vd-ssh-'), 'drops');
    fs.writeFileSync(drops, '3');
    const transport = new SshTransport({ ...SSH, retries: 8 }, { spawnImpl: fakeSpawn({ FAKE_SSH_DROPS: drops }), sleep: async () => {} });
    let r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, transport, now: () => Date.UTC(2026, 7, 1) });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.readFileSync(path.join(server, 'site', 'a b.txt'), 'utf8'), 'one\n');
    commitAll(repo, { 'a b.txt': 'two\n' });
    fs.writeFileSync(drops, '2');
    r = await run(['apply', 'site', '--apply'], { cwd: cfgDir, transport, now: () => Date.UTC(2026, 7, 2) });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.readFileSync(path.join(server, 'site', 'a b.txt'), 'utf8'), 'two\n');
    r = await run(['rollback', '20260802-000000', '--apply'], { cwd: cfgDir, transport });
    assert.equal(r.code, 0, r.all);
    assert.equal(fs.readFileSync(path.join(server, 'site', 'a b.txt'), 'utf8'), 'one\n');
});
