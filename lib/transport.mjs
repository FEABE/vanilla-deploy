/**
 * Transports run a command "on the server" with optional stdin and return { code, stdout, stderr }.
 *
 *   SshTransport        ssh -F none -i <key> ... user@host <command>. ~/.ssh/config is ignored on purpose (a
 *                       single unsupported option in it makes some ssh builds, e.g. Git for Windows, refuse to
 *                       start). Retries only pre-auth drops (retry.mjs).
 *   LocalBashTransport  runs the same commands with a local bash, against a local directory. Used by the tests
 *                       and for deploying to a mounted folder. On Windows it uses Git for Windows' bash, never
 *                       the WSL launcher in System32.
 *
 * runScript(t, script) sends a script on stdin to `bash -s` and throws on a non-zero exit.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withRetry, isPreAuthDrop, defaultSleep } from './retry.mjs';
import { shq } from './shell.mjs';
import { toBashPath } from './paths.mjs';

function collect(child, input) {
    return new Promise((resolve, reject) => {
        const out = [], err = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
        child.stdin.on('error', () => {});   // the other side may close early; the exit code tells the story
        child.stdin.end(input === undefined || input === null ? '' : input);
    });
}

export class SshTransport {
    constructor(ssh, { spawnImpl = spawn, sleep = defaultSleep, random = Math.random, onRetry = null } = {}) {
        this.ssh = ssh;
        this.spawnImpl = spawnImpl;
        this.sleep = sleep;
        this.random = random;
        this.onRetry = onRetry;
    }

    describe() { return this.ssh.user + '@' + this.ssh.host + ':' + this.ssh.port; }

    args(remoteCommand) {
        const s = this.ssh;
        const a = ['-F', 'none', '-p', String(s.port), '-i', s.key,
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + s.connectTimeout,
            '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=' + s.strictHostKeyChecking];
        if (s.knownHostsFile) a.push('-o', 'UserKnownHostsFile=' + s.knownHostsFile);
        a.push('--', s.user + '@' + s.host, remoteCommand);
        return a;
    }

    exec(remoteCommand, input) {
        return withRetry(async () => {
            const child = this.spawnImpl(this.ssh.command, this.args(remoteCommand), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            const r = await collect(child, input);
            if (isPreAuthDrop(r.code, r.stderr)) {
                const e = new Error('ssh connection dropped before key exchange');
                e.preAuth = true;
                e.result = r;
                throw e;
            }
            return r;
        }, {
            attempts: this.ssh.retries, sleep: this.sleep, random: this.random,
            onRetry: this.onRetry
        }).catch((e) => { if (e.preAuth && e.result) return e.result; throw e; });
    }
}

/** Git for Windows' bash (or plain `bash` elsewhere). Returns null when none works. */
export function findBash() {
    const works = (exe) => {
        const r = spawnSync(exe, ['-c', 'echo ok'], { encoding: 'utf8', windowsHide: true });
        return r.status === 0 && String(r.stdout).trim() === 'ok';
    };
    if (process.platform !== 'win32') return works('bash') ? 'bash' : null;
    const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const roots = [];
    if (exec.trim()) roots.push(path.resolve(exec.trim(), '..', '..', '..'));
    for (const env of ['ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA']) {
        if (process.env[env]) roots.push(path.join(process.env[env], 'Git'), path.join(process.env[env], 'Programs', 'Git'));
    }
    for (const root of roots) {
        for (const p of [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]) {
            if (fs.existsSync(p) && works(p)) return p;
        }
    }
    return null;
}

export class LocalBashTransport {
    /** pathPrepend: local directories put first on PATH (e.g. test shims for systemctl / curl). */
    constructor({ bash = null, pathPrepend = [], env = {} } = {}) {
        this.bash = bash || findBash();
        if (!this.bash) throw new Error('local transport: no bash found (install Git for Windows, or set transport.bash)');
        this.pathPrepend = pathPrepend;
        this.env = env;
    }

    describe() { return 'local bash'; }

    exec(command, input) {
        const dirs = this.pathPrepend.map(toBashPath);
        if (process.platform === 'win32') dirs.push('/usr/bin');   // coreutils before Windows' own sort.exe & co.
        const prefix = dirs.length ? 'export PATH=' + shq(dirs.join(':')) + '":$PATH"; ' : '';
        const child = spawn(this.bash, ['-c', prefix + command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env }, windowsHide: true });
        return collect(child, input);
    }
}

export class RemoteError extends Error {}

/** Runs a bash script remotely (prelude included by the caller) and returns stdout; throws on failure. */
export async function runScript(transport, script, what = 'remote command') {
    const r = await transport.exec('bash -s', script);
    if (r.code !== 0) {
        const e = new RemoteError(what + ' failed (exit ' + r.code + ')' + (r.stderr.trim() ? ': ' + r.stderr.trim().split('\n').slice(-5).join(' | ') : ''));
        e.result = r;
        throw e;
    }
    return r.stdout;
}

/** Runs a single command with binary stdin (the tar stream); throws on failure. */
export async function runWithInput(transport, command, input, what = 'transfer') {
    const r = await transport.exec(command, input);
    if (r.code !== 0) throw new RemoteError(what + ' failed (exit ' + r.code + ')' + (r.stderr.trim() ? ': ' + r.stderr.trim().split('\n').slice(-5).join(' | ') : ''));
    return r.stdout;
}
