/**
 * Change calculation and backup bookkeeping. Pure functions.
 *
 * Why blob hashes: every file in a git tree already has a content id (the blob sha). The server side hashes
 * its files the same way (git hash-object --no-filters, or sha1 over "blob <size>\0<bytes>"), so "changed"
 * means "different bytes" - not a different mtime, which checkouts, rebases and copies all reset.
 */
import { ancestors } from './paths.mjs';

/**
 * local: { head, files: { path: { sha, mode, size } } }
 * info:  { mode: 'present'|'missing', state: { meta, files } | null, cur: { path: sha } }
 *
 * add     in local, not on the server
 * update  in local, on the server with different bytes
 * remove  on the server, recorded in the previous deploy, no longer in local
 * drift   update/remove where the server bytes differ from what the previous deploy wrote (edited on the
 *         server, or a file this tool never deployed). Overwriting drift needs --force.
 * Files on the server that were never deployed by this tool and are not in local are left alone.
 */
export function diffPlan(target, local, info) {
    const prev = (info.state && info.state.files) || {};
    const plan = { target, local, info, add: [], update: [], remove: [], drift: [], same: 0 };
    const isDrift = (p) => info.cur[p] !== prev[p];
    for (const [p, f] of Object.entries(local.files)) {
        const cur = info.cur[p];
        if (cur === f.sha) plan.same++;
        else if (!cur) plan.add.push(p);
        else { plan.update.push(p); if (isDrift(p)) plan.drift.push(p); }
    }
    for (const p of Object.keys(prev)) {
        if (!local.files[p] && info.cur[p]) { plan.remove.push(p); if (isDrift(p)) plan.drift.push(p); }
    }
    for (const k of ['add', 'update', 'remove', 'drift']) plan[k].sort();
    return plan;
}

export function changeCount(plan) {
    return plan.add.length + plan.update.length + plan.remove.length;
}

/**
 * Directories (relative to remoteRoot) that may be created by this deploy: the target folder, its parents,
 * and parents of added files. The server records which of them did not exist yet.
 */
export function newDirCandidates(remoteDir, added) {
    const set = new Set([...ancestors(remoteDir), remoteDir]);
    for (const p of added) for (const a of ancestors(p)) set.add(remoteDir + '/' + a);
    return [...set].sort();
}

/** Deepest first, so `rmdir` can remove nested empty folders. */
export function deepestFirst(dirs) {
    return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1));
}

//--------------------------------------------------------------------------------------------------
// deploy ids and pruning
//--------------------------------------------------------------------------------------------------

export const ID_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d))?$/;

/** Deploy id from a UTC timestamp: YYYYMMDD-HHMMSS (the server adds -2, -3 ... on collisions). */
export function deployId(now = Date.now()) {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

export function idTime(id) {
    const m = ID_RE.exec(id);
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Backups to delete: older than keepDays, never the newest keepMin, never keepId, and only folders whose
 * name is a deploy id (anything else in the folder is left alone).
 */
export function backupsToPrune(names, { now = Date.now(), keepDays = 14, keepMin = 3, keepId = null } = {}) {
    const ids = names.filter((n) => Number.isFinite(idTime(n))).sort((a, b) => idTime(a) - idTime(b) || (a < b ? -1 : 1));
    const protectedIds = new Set(ids.slice(Math.max(0, ids.length - keepMin)));
    if (keepId) protectedIds.add(keepId);
    const cut = now - keepDays * 86400000;
    return ids.filter((n) => !protectedIds.has(n) && idTime(n) < cut);
}

//--------------------------------------------------------------------------------------------------
// transfer chunking and cache paths
//--------------------------------------------------------------------------------------------------

/** Splits paths into chunks whose total blob size stays under maxBytes (one tar stream per chunk). */
export function chunkBySize(paths, sizeOf, maxBytes = 64 * 1024 * 1024) {
    const chunks = [];
    let cur = [], bytes = 0;
    for (const p of paths) {
        const s = sizeOf(p) + 1024;
        if (cur.length && bytes + s > maxBytes) { chunks.push(cur); cur = []; bytes = 0; }
        cur.push(p); bytes += s;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

/** Changed paths that matter for the CDN cache, per the target's `cache.include`. */
export function cachePaths(plan, cacheMatcher) {
    if (!cacheMatcher) return [];
    return [...plan.add, ...plan.update, ...plan.remove].filter(cacheMatcher);
}

/** Public URL for a cache path: urlPrefix + path without stripPrefix, each segment percent-encoded. */
export function cacheUrl(urlPrefix, stripPrefix, p) {
    const rel = stripPrefix && p.startsWith(stripPrefix) ? p.slice(stripPrefix.length) : p;
    return urlPrefix + rel.split('/').map(encodeURIComponent).join('/');
}
