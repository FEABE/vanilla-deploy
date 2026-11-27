// Shared test helpers: temp git repos, a local "server" folder, a fake systemctl, and main() with a captured log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';
import { findBash } from '../lib/transport.mjs';
import { toBashPath } from '../lib/paths.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASH = findBash();
export const SKIP_NO_BASH = BASH ? false : 'no bash found (Git for Windows on Windows)';

export function tmpDir(prefix = 'vd-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(dir, ...args) {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
    return r.stdout;
}

/** Creates a repo with the given { path: content } files and commits them. */
export function makeRepo(files, dir = tmpDir('vd-repo-')) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.autocrlf', 'false');
    writeFiles(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
    return dir;
}

export function writeFiles(dir, files) {
    for (const [p, content] of Object.entries(files)) {
        const abs = path.join(dir, ...p.split('/'));
        if (content === null) { fs.rmSync(abs, { force: true }); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
}

export function commitAll(dir, files, msg = 'change') {
    writeFiles(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
}

function gitIn(dir, args, input) {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
}

/**
 * Commits a blob at an arbitrary path (one or two levels) by writing tree objects directly - for names that
 * neither the file system nor `git update-index` accept (newlines, backslashes, ...). The work tree is untouched.
 */
export function commitRawPath(dir, p, content) {
    const blob = gitIn(dir, ['hash-object', '-w', '--stdin'], content);
    const segs = p.split('/');
    if (segs.length > 2) throw new Error('commitRawPath: at most one folder level');
    const top = gitIn(dir, ['ls-tree', '-z', 'HEAD']).split('\0').filter(Boolean);
    let entry = '100644 blob ' + blob + '\t' + segs[segs.length - 1];
    if (segs.length === 2) entry = '040000 tree ' + gitIn(dir, ['mktree', '-z'], entry + '\0') + '\t' + segs[0];
    const tree = gitIn(dir, ['mktree', '-z'], [...top, entry].join('\0') + '\0');
    const commit = gitIn(dir, ['commit-tree', tree, '-p', 'HEAD', '-m', 'raw path']);
    gitIn(dir, ['update-ref', 'HEAD', commit]);
}

/** { relativePath: sha256 } of every file below dir (skipping .deploy/backups), plus the list of folders. */
export function snapshot(dir) {
    const files = {}, dirs = [];
    const walk = (abs, rel) => {
        if (!fs.existsSync(abs)) return;
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            const r = rel ? rel + '/' + e.name : e.name;
            if (r === '.deploy/backups') continue;
            const a = path.join(abs, e.name);
            if (e.isDirectory()) { dirs.push(r); walk(a, r); } else files[r] = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
        }
    };
    walk(dir, '');
    return { files, dirs: dirs.sort() };
}

/** A fake systemctl on PATH for the local transport: MainPID / is-active kept in $FAKE_SYSTEMD_DIR. */
export function fakeSystemd() {
    const bin = tmpDir('vd-bin-');
    const state = tmpDir('vd-systemd-');
    fs.copyFileSync(path.join(HERE, 'fixtures', 'fake-systemctl.sh'), path.join(bin, 'systemctl'));
    try { fs.chmodSync(path.join(bin, 'systemctl'), 0o755); } catch { /* Windows */ }
    return { bin, state, env: { FAKE_SYSTEMD_DIR: toBashPath(state) }, restarts: () => (fs.existsSync(path.join(state, 'restarts.log')) ? fs.readFileSync(path.join(state, 'restarts.log'), 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/** Writes deploy.config.json for a local "server" in `serverDir` and returns its folder. */
export function writeConfig(dir, cfg) {
    fs.writeFileSync(path.join(dir, 'deploy.config.json'), JSON.stringify(cfg, null, 2));
    return dir;
}

export function localConfig(serverDir, targets, extra = {}) {
    return Object.assign({ transport: { type: 'local' }, remoteRoot: toBashPath(serverDir), restart: { mode: 'none' }, targets }, extra);
}

/** Runs main() in-process; returns { code, out, err, all }. */
export async function run(argv, { cwd, env = {}, now, fetchImpl, transport, systemd } = {}) {
    const out = [], err = [];
    const code = await main(argv, {
        cwd, env: { ...env }, now, fetchImpl, transport, color: false,
        out: (s) => out.push(s), err: (s) => err.push(s),
        localTransport: systemd ? { pathPrepend: [systemd.bin], env: systemd.env } : {}
    });
    return { code, out: out.join('\n'), err: err.join('\n'), all: out.concat(err).join('\n') };
}

export function blobSha(content) {
    const buf = Buffer.from(content);
    return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
}

export function runBash(script, opts = {}) {
    return spawnSync(BASH, ['-c', 'export PATH="/usr/bin:$PATH"; ' + script], { encoding: 'utf8', ...opts });
}
