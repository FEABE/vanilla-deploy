/**
 * Path validation.
 *
 * Every relative path that ends up in a remote shell script goes through checkRelPath(): file names
 * from the local git tree, remoteDir values from the config, and every path read back from the server
 * (deploy records, backup lists). Names are always single-quoted or passed through quoted heredocs,
 * so spaces, quotes, `$(...)` and backticks are harmless. What we cannot carry safely through
 * line-oriented shell plumbing is rejected outright: control characters (newline, CR, tab, NUL, ...),
 * backslashes, absolute paths, empty / "." / ".." segments, and segments with leading or trailing
 * whitespace.
 */
import path from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 4096;

export class PathError extends Error {}

/** Returns null when `p` is a safe relative POSIX path, otherwise a short reason. */
export function checkRelPath(p) {
    if (typeof p !== 'string' || p === '') return 'empty path';
    if (p.length > MAX_PATH) return 'path is too long';
    if (CONTROL.test(p)) return 'contains a control character (newline, tab, ...)';
    if (p.includes('\\')) return 'contains a backslash';
    if (p.startsWith('/')) return 'is absolute';
    for (const seg of p.split('/')) {
        if (seg === '') return 'has an empty segment (leading, trailing or double slash)';
        if (seg === '.' || seg === '..') return 'has a "." or ".." segment';
        if (seg !== seg.trim()) return 'has a segment with leading or trailing whitespace';
    }
    return null;
}

/** Throws PathError unless `p` is a safe relative path. */
export function assertRelPath(p, what = 'path') {
    const why = checkRelPath(p);
    if (why) throw new PathError(what + ' ' + JSON.stringify(p) + ' ' + why);
    return p;
}

/** remoteRoot: absolute, normalised POSIX path, not "/", no trailing slash, same character rules. */
export function checkRemoteRoot(r) {
    if (typeof r !== 'string' || !r.startsWith('/')) return 'must be an absolute POSIX path (starting with "/")';
    if (r === '/') return 'must not be "/"';
    if (r.endsWith('/')) return 'must not end with "/"';
    const why = checkRelPath(r.slice(1));
    return why;
}

/** remoteDir: a safe relative path that does not reach into the tool's own ".deploy" folder. */
export function checkRemoteDir(d) {
    const why = checkRelPath(d);
    if (why) return why;
    if (d.split('/')[0] === '.deploy') return 'must not be inside ".deploy" (reserved for deploy records and backups)';
    return null;
}

/** Joins remoteRoot and a relative path and proves the result stays under remoteRoot. */
export function remoteJoin(root, rel) {
    assertRelPath(rel);
    const full = root + '/' + rel;
    if (path.posix.normalize(full) !== full || !full.startsWith(root + '/')) throw new PathError('path escapes remoteRoot: ' + JSON.stringify(rel));
    return full;
}

/** True when one relative directory equals or contains the other ("a" and "a/b"). */
export function dirsOverlap(a, b) {
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** All ancestor directories of a relative file path, outermost first ("a/b/c.txt" -> ["a", "a/b"]). */
export function ancestors(p) {
    const segs = p.split('/');
    const out = [];
    for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
    return out;
}

/** Windows path -> MSYS / Git Bash path ("C:\\x\\y" -> "/c/x/y"). Other paths are returned with "/" separators. */
export function toBashPath(p) {
    const s = String(p).replace(/\\/g, '/');
    const m = /^([A-Za-z]):(\/.*)?$/.exec(s);
    return m ? '/' + m[1].toLowerCase() + (m[2] || '') : s;
}
