/**
 * Local git access. Only committed content (HEAD) is ever deployed: the file list and blob ids come from
 * `git ls-tree`, the bytes from `git cat-file --batch`. Uncommitted edits and untracked files (.env, local
 * data) never leave the machine. `repo` may be the root of a work tree or any directory inside one; paths
 * are relative to that directory.
 */
import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 1024 * 1024 * 1024;

export function git(dir, args, { input, buffer = false, allowFail = false } = {}) {
    const r = spawnSync('git', ['-C', dir, '--literal-pathspecs', '-c', 'core.quotepath=off', ...args], {
        input, maxBuffer: MAX_BUFFER, windowsHide: true, ...(buffer ? {} : { encoding: 'utf8' })
    });
    if (r.error) throw new Error('cannot run git: ' + r.error.message);
    if (r.status !== 0) {
        if (allowFail) return null;
        throw new Error('git ' + args[0] + ' failed in ' + dir + ': ' + String(r.stderr).trim());
    }
    return r.stdout;
}

/**
 * HEAD tree below `dir`: { head, files: { path: { sha, mode, size } }, skipped: [paths] }.
 * Symlinks and submodules are skipped (reported in `skipped`).
 */
export function localTree(dir) {
    const head = git(dir, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const out = git(dir, ['ls-tree', '-r', '-l', '-z', 'HEAD']);
    const files = {};
    const skipped = [];
    for (const rec of out.split('\0')) {
        if (!rec) continue;
        const tab = rec.indexOf('\t');
        const [mode, type, sha, size] = rec.slice(0, tab).trim().split(/\s+/);
        const p = rec.slice(tab + 1);
        if (type !== 'blob' || mode === '120000') { skipped.push(p); continue; }
        files[p] = { sha, mode, size: Number(size) };
    }
    return { head, files, skipped };
}

/** Uncommitted changes below `dir` (tracked and untracked), as paths relative to `dir`. */
export function dirtyPaths(dir) {
    const prefix = git(dir, ['rev-parse', '--show-prefix']).trim();
    const out = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.']);
    const recs = out.split('\0');
    const paths = [];
    for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (!r) continue;
        const xy = r.slice(0, 2);
        const p = r.slice(3);
        if (xy[0] === 'R' || xy[0] === 'C') i++;   // the next record is the rename source
        paths.push(p.startsWith(prefix) ? p.slice(prefix.length) : p);
    }
    return paths;
}

/** Map sha -> Buffer for the given blob ids (one `git cat-file --batch` call). */
export function readBlobs(dir, shas) {
    const want = [...new Set(shas)];
    const map = new Map();
    if (!want.length) return map;
    const out = git(dir, ['cat-file', '--batch'], { input: want.join('\n') + '\n', buffer: true });
    let pos = 0;
    while (pos < out.length) {
        const nl = out.indexOf(0x0a, pos);
        if (nl < 0) break;
        const head = out.subarray(pos, nl).toString('utf8').split(' ');
        pos = nl + 1;
        if (head[1] === 'missing') throw new Error('git object missing: ' + head[0]);
        const size = Number(head[2]);
        map.set(head[0], out.subarray(pos, pos + size));
        pos += size + 1;   // content + trailing LF
    }
    for (const s of want) if (!map.has(s)) throw new Error('git object not returned: ' + s);
    return map;
}
