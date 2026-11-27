/**
 * vanilla-deploy command line. main(argv, deps) returns an exit code and never calls process.exit, so the
 * tests can drive it in-process with a local transport, a fake clock and a captured log.
 *
 *   plan     <target...|all>            show what would change (never writes)
 *   apply    <target...|all> [--apply]  without --apply: the same plan, as a rehearsal. With --apply:
 *                                       backup -> transfer -> hash verify -> record -> restart -> purge -> prune
 *   rollback <id> [--apply]             put back exactly what deploy <id> overwrote, deleted or created
 *   list                                targets, deploy records, recent deploy ids, unit states
 *   restart  <target...|all> [--apply]  restart the targets' units and wait for health
 *   prune    [--apply]                  delete backups older than backups.keepDays (keeps backups.keepMin)
 *   purge    [--apply]                  purge the whole Cloudflare zone cache
 *
 * Exit codes: 0 ok, 1 failed, 2 usage or config error.
 */
import fs from 'node:fs';
import { checkRelPath, assertRelPath } from './paths.mjs';
import { loadConfig, ConfigError } from './config.mjs';
import { localTree, dirtyPaths, readBlobs } from './git.mjs';
import { buildTar } from './tar.mjs';
import {
    prelude, infoScript, parseInfo, beginScript, backupScript, extractCommand, finalizeScript, parseFinalize,
    stateText, restartScript, parseRestart, readManifestScript, rollbackInfoScript, rollbackScript, markRolledBackScript,
    listBackupsScript, listScript, pruneScript, sections, rawLines
} from './scripts.mjs';
import { diffPlan, changeCount, newDirCandidates, deepestFirst, deployId, ID_RE, backupsToPrune, chunkBySize, cachePaths, cacheUrl } from './plan.mjs';
import { SshTransport, LocalBashTransport, runScript, runWithInput } from './transport.mjs';
import { cloudflareAuth, purgeCache } from './cloudflare.mjs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class DeployError extends Error {}
export class UsageError extends Error {}

const USAGE = `vanilla-deploy ${VERSION} - deploy git HEAD to a server over ssh, dry-run by default

Usage:
  vanilla-deploy plan     <target...|all>
  vanilla-deploy apply    <target...|all> [--apply] [--allow-dirty] [--force] [--no-restart] [--no-purge]
  vanilla-deploy rollback <deploy-id>     [--apply] [--force] [--no-restart] [--no-purge]
  vanilla-deploy list
  vanilla-deploy restart  <target...|all> [--apply]
  vanilla-deploy prune    [--apply]
  vanilla-deploy purge    [--apply]

Options:
  --apply         actually do it (every command that changes something is a dry-run without it)
  --allow-dirty   deploy HEAD even though the work tree has uncommitted changes
  --force         overwrite files changed on the server (drift); roll back a deploy that is not the latest
  --no-restart    do not restart units
  --no-purge      do not purge the CDN cache
  --config <file> config file (default: ./deploy.config.json or ./deploy.config.mjs)
  -h, --help      this help
  --version       print the version`;

const BOOL_FLAGS = new Set(['--apply', '--allow-dirty', '--force', '--no-restart', '--no-purge', '--help', '-h', '--version']);
const COMMANDS = new Set(['plan', 'apply', 'rollback', 'list', 'restart', 'prune', 'purge', 'help']);
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,254}$/;
const MAX_LISTED = 40;

export function parseArgs(argv) {
    const flags = new Set();
    const args = [];
    let config = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--config') { config = argv[++i]; if (!config) throw new UsageError('--config needs a file'); continue; }
        if (a.startsWith('--config=')) { config = a.slice('--config='.length); continue; }
        if (a.startsWith('-')) {
            if (!BOOL_FLAGS.has(a)) throw new UsageError('unknown option ' + a);
            flags.add(a === '-h' ? '--help' : a);
            continue;
        }
        args.push(a);
    }
    return { command: args[0] || null, args: args.slice(1), flags, config };
}

function makeLog(out, err, color) {
    const c = color ? { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' } : { r: '', g: '', y: '', d: '', b: '', x: '' };
    return {
        c,
        line: (s = '') => out(s),
        dim: (s) => out(c.d + s + c.x),
        ok: (s) => out(c.g + s + c.x),
        warn: (s) => out(c.y + s + c.x),
        error: (s) => err(c.r + s + c.x)
    };
}

function selectTargets(config, names) {
    if (!names.length) throw new UsageError('name one or more targets (or "all"). Targets: ' + Object.keys(config.targets).join(', '));
    const out = [];
    for (const n of names) {
        const list = n === 'all' ? Object.values(config.targets) : [config.targets[n]];
        if (!list[0]) throw new UsageError('unknown target "' + n + '". Targets: ' + Object.keys(config.targets).join(', ') + ', all');
        for (const t of list) if (!out.includes(t)) out.push(t);
    }
    return out;
}

function short(sha) { return sha ? String(sha).slice(0, 7) : '-'; }

//--------------------------------------------------------------------------------------------------
// plan
//--------------------------------------------------------------------------------------------------

async function planTarget(ctx, t) {
    if (!fs.existsSync(t.repo)) throw new DeployError('target ' + t.name + ': repo folder not found: ' + t.repo);
    const tree = localTree(t.repo);
    const files = {};
    const invalid = [];
    for (const [p, f] of Object.entries(tree.files)) {
        if (!t.matcher(p)) continue;
        const why = checkRelPath(p);
        if (why) invalid.push(JSON.stringify(p) + ' ' + why); else files[p] = f;
    }
    if (invalid.length) {
        throw new DeployError('target ' + t.name + ': file names that cannot be deployed safely:\n  ' + invalid.slice(0, 20).join('\n  ')
            + (invalid.length > 20 ? '\n  ... and ' + (invalid.length - 20) + ' more' : '') + '\nRename them or add them to "exclude".');
    }
    const dirty = dirtyPaths(t.repo).filter((p) => t.matcher(p));
    const local = { head: tree.head, files, skipped: tree.skipped.filter((p) => t.matcher(p)) };
    const out = await runScript(ctx.transport, ctx.prelude + infoScript(t, Object.keys(files).sort()), 'reading the server state of ' + t.name);
    const plan = diffPlan(t, local, parseInfo(out));
    plan.dirty = dirty;
    plan.cache = cachePaths(plan, t.cache && t.cache.matcher);
    return plan;
}

function printPlan(log, plan) {
    const { c } = log;
    const st = plan.info.state && plan.info.state.meta;
    const n = changeCount(plan);
    log.line(c.b + plan.target.name + c.x + c.d + ' -> ' + plan.target.remoteDir + '  (local ' + short(plan.local.head)
        + (st ? ', deployed ' + short(st.head) + ' in ' + st.deploy_id : ', never deployed') + ')' + c.x
        + (n ? '  ' + c.y + '+' + plan.add.length + ' ~' + plan.update.length + ' -' + plan.remove.length + c.x : '  ' + c.g + 'up to date' + c.x)
        + c.d + '  same ' + plan.same + c.x);
    if (plan.dirty.length) log.warn('  ! ' + plan.dirty.length + ' uncommitted change(s) in the work tree - only HEAD is deployed');
    if (plan.info.mode === 'missing') log.warn('  ! ' + plan.target.remoteDir + ' does not exist on the server yet - it is created on --apply');
    if (plan.local.skipped.length) log.dim('  (' + plan.local.skipped.length + ' symlink(s) / submodule(s) skipped)');
    let shown = 0;
    const show = (sym, list, color) => {
        for (const p of list) {
            if (shown++ >= MAX_LISTED) continue;
            log.line('  ' + color + sym + ' ' + p + c.x + (plan.drift.includes(p) ? c.r + '  <- changed on the server (drift)' + c.x : ''));
        }
    };
    show('+', plan.add, c.g); show('~', plan.update, c.y); show('-', plan.remove, c.r);
    if (shown > MAX_LISTED) log.dim('  ... and ' + (shown - MAX_LISTED) + ' more');
}

/** Units to restart for the changed targets, config order, `restart.last` units at the end. */
export function affectedUnits(config, targets) {
    const seen = new Map();
    for (const t of targets) for (const u of t.units) if (!seen.has(u)) seen.set(u, { unit: u, health: t.health });
    const all = [...seen.values()];
    const last = new Set(config.restart.last);
    return [all.filter((r) => !last.has(r.unit)), all.filter((r) => last.has(r.unit))].filter((g) => g.length);
}

//--------------------------------------------------------------------------------------------------
// apply
//--------------------------------------------------------------------------------------------------

async function applyTarget(ctx, plan, id) {
    const t = plan.target;
    await runScript(ctx.transport, ctx.prelude + backupScript(t, id, plan, newDirCandidates(t.remoteDir, plan.add)), 'backup of ' + t.name);
    const send = [...plan.add, ...plan.update];
    const mtime = Math.floor(ctx.now() / 1000);
    for (const chunk of chunkBySize(send, (p) => plan.local.files[p].size)) {
        const blobs = readBlobs(t.repo, chunk.map((p) => plan.local.files[p].sha));
        const tar = buildTar(chunk.map((p) => {
            const f = plan.local.files[p];
            return { path: p, data: blobs.get(f.sha), mode: f.mode === '100755' ? 0o755 : 0o644 };
        }), mtime);
        await runWithInput(ctx.transport, extractCommand(ctx.config.remoteRoot, t), tar, 'transfer to ' + t.name);
    }
    const expect = send.map((p) => plan.local.files[p].sha + ' ' + p);
    const shas = {};
    for (const [p, f] of Object.entries(plan.local.files)) shas[p] = f.sha;
    const meta = { target: t.name, head: plan.local.head, deployed_at: new Date(ctx.now()).toISOString(), deploy_id: id };
    const out = await runScript(ctx.transport, ctx.prelude + finalizeScript(t, plan, expect, stateText(meta, shas)), 'verification of ' + t.name);
    const res = parseFinalize(out, expect);
    if (!res.ok) {
        throw new DeployError(t.name + ': verification failed - the server files do not match HEAD'
            + (res.mismatched.length ? '\n  hash mismatch: ' + res.mismatched.slice(0, 10).join(', ') : '')
            + (res.left.length ? '\n  not deleted: ' + res.left.slice(0, 10).join(', ') : ''));
    }
    ctx.log.ok('  ok ' + t.name + ctx.log.c.d + '  sent ' + send.length + ', deleted ' + plan.remove.length + ', hashes verified' + ctx.log.c.x);
}

async function restartGroups(ctx, groups) {
    const { log, config } = ctx;
    for (const group of groups) {
        log.dim('restarting ' + group.map((r) => r.unit).join(', '));
        const out = await runScript(ctx.transport, ctx.prelude + restartScript(group, config.restart.timeoutSec), 'restart');
        const r = parseRestart(out);
        r.up.forEach((u) => log.ok('  up ' + u.unit + log.c.d + ' after ' + u.seconds + 's' + log.c.x));
        r.down.forEach((u) => log.error('  down ' + u.unit + ' (' + u.state + ') - see: journalctl ' + (config.restart.mode === 'user' ? '--user ' : '') + '-u ' + u.unit));
        const missing = group.filter((g) => !r.up.some((u) => u.unit === g.unit) && !r.down.some((u) => u.unit === g.unit));
        if (r.down.length || missing.length) throw new DeployError('restart failed: ' + [...r.down.map((u) => u.unit), ...missing.map((u) => u.unit)].join(', '));
    }
}

async function doPurge(ctx, items, why) {
    const { log, config } = ctx;
    if (!items.length) return;
    if (ctx.flags.has('--no-purge')) { log.dim('cache purge skipped (--no-purge)'); return; }
    const auth = cloudflareAuth(config.cloudflare, ctx.env);
    if (!auth.ok) {
        log.warn('cache purge skipped (' + auth.why + ') - ' + items.length + ' cached file(s) changed' + why);
        items.slice(0, 20).forEach((i) => log.dim('    ' + i.target.name + ': ' + i.path));
        if (items.length > 20) log.dim('    ... and ' + (items.length - 20) + ' more');
        return;
    }
    const urls = config.cloudflare.urlPrefix ? items.map((i) => cacheUrl(config.cloudflare.urlPrefix, i.target.cache.stripPrefix, i.path)) : null;
    const r = await purgeCache(config.cloudflare, auth, urls, { fetchImpl: ctx.fetchImpl });
    if (r.ok) log.ok('  ok cache purged (' + (urls ? urls.length + ' URL(s)' : 'everything') + ')');
    else log.warn('  cache purge failed: ' + r.why + ' - purge it by hand');
}

async function prune(ctx, apply, keepId, quiet = false) {
    const { log, config } = ctx;
    const out = await runScript(ctx.transport, ctx.prelude + listBackupsScript(), 'listing backups');
    const names = rawLines(sections(out).BACKUPS);
    const old = backupsToPrune(names, { now: ctx.now(), keepDays: config.backups.keepDays, keepMin: config.backups.keepMin, keepId });
    if (!old.length) { if (!quiet) log.dim('no backups older than ' + config.backups.keepDays + ' days to prune'); return []; }
    const what = old.length + ' backup(s) older than ' + config.backups.keepDays + ' days (' + old[0] + (old.length > 1 ? ' ... ' + old[old.length - 1] : '') + ')';
    if (!apply) { log.dim('would prune ' + what); return old; }
    await runScript(ctx.transport, ctx.prelude + pruneScript(old), 'pruning backups');
    log.dim('pruned ' + what + '; those deploys can no longer be rolled back');
    return old;
}

async function cmdApply(ctx, names, isPlanCmd) {
    const { log, flags, config } = ctx;
    const apply = flags.has('--apply');
    const plans = [];
    for (const t of selectTargets(config, names)) { const p = await planTarget(ctx, t); printPlan(log, p); plans.push(p); }
    const changed = plans.filter((p) => changeCount(p));
    if (!changed.length) { log.ok('Nothing to deploy.'); return 0; }
    const drift = changed.flatMap((p) => p.drift.map((f) => p.target.name + ': ' + f));
    const dirty = changed.filter((p) => p.dirty.length);
    const groups = config.restart.mode === 'none' ? [] : affectedUnits(config, changed.map((p) => p.target));
    const cacheItems = changed.flatMap((p) => p.cache.map((c) => ({ target: p.target, path: c })));

    if (!apply) {
        log.line('');
        log.warn('dry-run: nothing was changed.' + (isPlanCmd ? ' To deploy: vanilla-deploy apply ' + names.join(' ') + ' --apply' : ' Add --apply to deploy.'));
        if (drift.length) log.error('--apply would stop: ' + drift.length + ' file(s) changed on the server (drift); --force overwrites them (they are backed up)');
        if (dirty.length) log.warn('--apply would stop: uncommitted changes in ' + dirty.map((p) => p.target.name).join(', ') + ' (commit, or --allow-dirty to deploy HEAD anyway)');
        if (groups.length) log.dim('restart: ' + groups.flat().map((r) => r.unit).join(', ') + (flags.has('--no-restart') ? ' (skipped: --no-restart)' : ''));
        if (cacheItems.length) {
            const auth = cloudflareAuth(config.cloudflare, ctx.env);
            log.dim('cache: ' + cacheItems.length + ' cached file(s) change - ' + (flags.has('--no-purge') ? 'no purge (--no-purge)' : auth.ok ? 'purged after the deploy' : 'purge skipped (' + auth.why + ')'));
        }
        await prune(ctx, false, null, true);
        return 0;
    }
    if (drift.length && !flags.has('--force')) throw new DeployError('stopped: files changed on the server (drift). Inspect them, then re-run with --force to overwrite (they are backed up):\n  ' + drift.slice(0, 30).join('\n  '));
    if (dirty.length && !flags.has('--allow-dirty')) throw new DeployError('stopped: uncommitted changes in ' + dirty.map((p) => p.target.name).join(', ') + '. Commit them, or use --allow-dirty to deploy HEAD anyway.');

    const manifest = {
        tool: 'vanilla-deploy', version: VERSION, created_at: new Date(ctx.now()).toISOString(),
        targets: changed.map((p) => ({ name: p.target.name, remoteDir: p.target.remoteDir, head: p.local.head, previous: p.info.state ? p.info.state.meta.deploy_id || null : null, cache: p.cache })),
        units: groups.flat()
    };
    const begin = await runScript(ctx.transport, ctx.prelude + beginScript(deployId(ctx.now()), manifest), 'starting the deploy');
    const m = /^#@ID (\S+)$/m.exec(begin);
    if (!m || !ID_RE.test(m[1])) throw new DeployError('server did not confirm a deploy id');
    const id = m[1];
    log.line('');
    log.line(log.c.b + 'deploy ' + id + log.c.x);
    const hint = '\nRoll back with: vanilla-deploy rollback ' + id + ' --apply';
    try {
        for (const p of changed) await applyTarget(ctx, p, id);
        if (groups.length && !flags.has('--no-restart')) await restartGroups(ctx, groups);
        else if (groups.length) log.dim('restart skipped (--no-restart): ' + groups.flat().map((r) => r.unit).join(', '));
    } catch (e) {
        e.message += hint;
        throw e;
    }
    await doPurge(ctx, cacheItems, '');
    try { await prune(ctx, true, id, true); } catch (e) { log.warn('pruning old backups failed (the deploy itself is done): ' + e.message); }
    log.line('');
    log.ok('done ' + id + log.c.d + hint.replace('\n', '  ') + log.c.x);
    return 0;
}

//--------------------------------------------------------------------------------------------------
// rollback
//--------------------------------------------------------------------------------------------------

async function cmdRollback(ctx, args) {
    const { log, flags, config } = ctx;
    const id = args[0];
    if (!id) throw new UsageError('rollback needs a deploy id (see: vanilla-deploy list)');
    if (!ID_RE.test(id)) throw new UsageError('not a deploy id: ' + JSON.stringify(id));
    const s = sections(await runScript(ctx.transport, ctx.prelude + readManifestScript(id), 'reading deploy ' + id));
    let manifest;
    try { manifest = JSON.parse((s.MANIFEST || []).join('\n')); } catch { throw new DeployError('deploy ' + id + ': manifest is not readable'); }
    if (!manifest || !Array.isArray(manifest.targets)) throw new DeployError('deploy ' + id + ': manifest is not readable');
    const rolled = (s.ROLLED || [])[0];
    if (rolled && !flags.has('--force')) throw new DeployError('deploy ' + id + ' was already rolled back (' + rolled + '); --force to do it again');

    const items = [];
    const conflicts = [];
    for (const mt of manifest.targets) {
        const name = mt && typeof mt.name === 'string' ? mt.name : null;
        const t = name && Object.hasOwn(config.targets, name) ? config.targets[name] : null;
        if (!t) throw new DeployError('deploy ' + id + ' touched target ' + JSON.stringify(name) + ', which is not in the config');
        if (t.remoteDir !== mt.remoteDir) throw new DeployError('target ' + t.name + ': remoteDir is "' + t.remoteDir + '" in the config but was "' + mt.remoteDir + '" at deploy ' + id + '; refusing to guess');
        const info = sections(await runScript(ctx.transport, ctx.prelude + rollbackInfoScript(id, t), 'reading backup of ' + t.name));
        if ((info.HASBACKUP || [])[0] !== 'yes') { log.dim(t.name + ': not reached by deploy ' + id + ' - nothing to restore'); continue; }
        const added = rawLines(info.ADDED).map((p) => assertRelPath(p, 'backup entry'));
        const newDirs = rawLines(info.NEWDIRS).map((p) => assertRelPath(p, 'backup entry'));
        const restore = rawLines(info.RESTORE).map((p) => assertRelPath(p, 'backup entry'));
        const hasState = (info.HASSTATE || [])[0] === 'yes';
        let current = null;
        try { current = info.CURRENT && info.CURRENT[0] ? JSON.parse(info.CURRENT[0]).deploy_id || null : null; } catch { current = null; }
        // current === id: the deploy finished for this target. current === previous: it failed before writing
        // the record (transfer or verification), which is exactly when the printed rollback command is needed.
        const previous = typeof mt.previous === 'string' ? mt.previous : null;
        if (current !== id && current !== previous) conflicts.push(t.name + ' (current deploy: ' + (current || 'none') + ')');
        items.push({ t, mt, added, newDirs, restore, hasState });
        log.line(log.c.b + t.name + log.c.x + log.c.d + ' -> ' + t.remoteDir + log.c.x + '  restore ' + restore.length + ', delete ' + added.length + ' created file(s)'
            + (newDirs.length ? ' and up to ' + newDirs.length + ' created folder(s)' : '') + ', deploy record: ' + (hasState ? 'previous one restored' : 'removed (first deploy)'));
        let shown = 0;
        for (const p of restore) if (shown++ < MAX_LISTED) log.line('  ' + log.c.y + '< ' + p + log.c.x);
        for (const p of added) if (shown++ < MAX_LISTED) log.line('  ' + log.c.r + '- ' + p + log.c.x);
        if (shown > MAX_LISTED) log.dim('  ... and ' + (shown - MAX_LISTED) + ' more');
    }
    if (conflicts.length) {
        const msg = 'deployed again after ' + id + ': ' + conflicts.join(', ') + '. Roll back the newer deploy first, or --force.';
        if (!flags.has('--apply')) log.error('--apply would stop: ' + msg);
        else if (!flags.has('--force')) throw new DeployError('stopped: ' + msg);
    }
    const units = (Array.isArray(manifest.units) ? manifest.units : []).filter((u) => u && UNIT_NAME.test(u.unit)).map((u) => {
        const known = Object.values(config.targets).find((t) => t.units.includes(u.unit));
        return { unit: u.unit, health: known ? known.health : null };
    });
    const groups = config.restart.mode === 'none' ? [] : [units.filter((u) => !config.restart.last.includes(u.unit)), units.filter((u) => config.restart.last.includes(u.unit))].filter((g) => g.length);
    if (!flags.has('--apply')) {
        log.line('');
        log.warn('dry-run: nothing was changed. Add --apply to roll back ' + id + '.');
        if (groups.length) log.dim('restart: ' + groups.flat().map((r) => r.unit).join(', '));
        return 0;
    }
    for (const it of items) {
        await runScript(ctx.transport, ctx.prelude + rollbackScript(id, it.t, it.added, deepestFirst(it.newDirs)), 'rollback of ' + it.t.name);
        log.ok('  ok ' + it.t.name + ' restored');
    }
    await runScript(ctx.transport, ctx.prelude + markRolledBackScript(id, new Date(ctx.now()).toISOString()), 'marking ' + id);
    if (groups.length && !flags.has('--no-restart')) await restartGroups(ctx, groups);
    const cacheItems = items.flatMap((it) => (Array.isArray(it.mt.cache) ? it.mt.cache : []).filter((p) => !checkRelPath(p) && it.t.cache).map((p) => ({ target: it.t, path: p })));
    await doPurge(ctx, cacheItems, '');
    log.ok('rolled back ' + id);
    return 0;
}

//--------------------------------------------------------------------------------------------------
// list, restart, prune, purge
//--------------------------------------------------------------------------------------------------

async function cmdList(ctx) {
    const { log, config } = ctx;
    const targets = Object.values(config.targets);
    const units = [...new Set(targets.flatMap((t) => t.units))];
    const s = sections(await runScript(ctx.transport, ctx.prelude + listScript(targets.map((t) => t.name), units, config.restart.mode !== 'none'), 'list'));
    const states = {};
    for (const l of s.STATES || []) {
        const i = l.indexOf(' ');
        try { states[l.slice(0, i)] = JSON.parse(l.slice(i + 1)); } catch { /* unreadable record */ }
    }
    log.line(log.c.b + 'targets' + log.c.x);
    for (const t of targets) {
        const st = states[t.name];
        log.line('  ' + t.name + log.c.d + ' -> ' + t.remoteDir + (t.units.length ? '  units: ' + t.units.join(', ') : '') + log.c.x
            + '  ' + (st ? 'deployed ' + short(st.head) + ' at ' + st.deployed_at + ' (' + st.deploy_id + ')' : log.c.d + 'never deployed' + log.c.x));
    }
    const backups = rawLines(s.BACKUPS);
    log.line(log.c.b + 'recent deploys' + log.c.x + log.c.d + ' (ids for rollback)' + log.c.x);
    if (!backups.length) log.dim('  none');
    for (const l of backups) {
        const sp = l.indexOf(' {');
        const head = sp < 0 ? l.split(' -')[0] : l.slice(0, sp);
        let names = '';
        try { names = sp < 0 ? '' : JSON.parse(l.slice(sp + 1)).targets.map((t) => t.name).join(', '); } catch { names = '?'; }
        log.line('  ' + head + log.c.d + (names ? '  ' + names : '') + log.c.x);
    }
    if (config.restart.mode !== 'none' && units.length) {
        log.line(log.c.b + 'units' + log.c.x);
        for (const l of s.UNITS || []) {
            const [u, state] = l.split(' ');
            log.line('  ' + (state === 'active' ? log.c.g : log.c.r) + '*' + log.c.x + ' ' + u + log.c.d + ' ' + (state || 'unknown') + log.c.x);
        }
    }
    return 0;
}

async function cmdRestart(ctx, names) {
    const { log, config, flags } = ctx;
    if (config.restart.mode === 'none') { log.warn('restart.mode is "none" - nothing to restart'); return 0; }
    const groups = affectedUnits(config, selectTargets(config, names));
    if (!groups.length) { log.warn('these targets have no units'); return 0; }
    if (!flags.has('--apply')) { log.warn('dry-run: would restart ' + groups.flat().map((r) => r.unit).join(', ') + '. Add --apply.'); return 0; }
    await restartGroups(ctx, groups);
    return 0;
}

async function cmdPurge(ctx) {
    const { log, config, flags } = ctx;
    const auth = cloudflareAuth(config.cloudflare, ctx.env);
    if (!auth.ok) { log.warn('cache purge is off (' + auth.why + ')'); return config.cloudflare ? 1 : 0; }
    if (!flags.has('--apply')) { log.warn('dry-run: would purge the whole zone cache. Add --apply.'); return 0; }
    const r = await purgeCache(config.cloudflare, auth, null, { fetchImpl: ctx.fetchImpl });
    if (!r.ok) { log.error('cache purge failed: ' + r.why); return 1; }
    log.ok('cache purged (everything)');
    return 0;
}

//--------------------------------------------------------------------------------------------------
// main
//--------------------------------------------------------------------------------------------------

function makeTransport(config, deps, log) {
    if (deps.transport) return deps.transport;
    if (config.transport.type === 'local') return new LocalBashTransport({ bash: config.transport.bash, ...(deps.localTransport || {}) });
    return new SshTransport(config.ssh, {
        onRetry: (e, i, ms) => log.dim('  ssh connection dropped before key exchange - retrying in ' + (ms / 1000).toFixed(1) + 's (' + i + '/' + (config.ssh.retries - 1) + ')')
    });
}

/**
 * deps: { cwd, env, out(line), err(line), color, now(), fetchImpl, transport, localTransport: { pathPrepend, env } }
 */
export async function main(argv, deps = {}) {
    const out = deps.out || ((s) => process.stdout.write(s + '\n'));
    const err = deps.err || ((s) => process.stderr.write(s + '\n'));
    const env = deps.env || process.env;
    const color = deps.color !== undefined ? deps.color : !!(process.stdout.isTTY && !env.NO_COLOR);
    const log = makeLog(out, err, color);
    try {
        const { command, args, flags, config: configPath } = parseArgs(argv);
        if (flags.has('--version')) { out(VERSION); return 0; }
        if (flags.has('--help') || !command || command === 'help') { out(USAGE); return command || flags.has('--help') ? 0 : 2; }
        if (!COMMANDS.has(command)) throw new UsageError('unknown command "' + command + '" (plan, apply, rollback, list, restart, prune, purge)');
        if (command === 'plan' && flags.has('--apply')) throw new UsageError('plan never changes anything; use: vanilla-deploy apply ' + args.join(' ') + ' --apply');
        const config = await loadConfig(configPath, deps.cwd || process.cwd());
        const transport = makeTransport(config, deps, log);
        const ctx = {
            config, transport, log, flags, env,
            now: deps.now || Date.now,
            fetchImpl: deps.fetchImpl || globalThis.fetch,
            prelude: prelude(config.remoteRoot, config.restart)
        };
        log.dim('vanilla-deploy ' + VERSION + ' -> ' + transport.describe() + ' ' + config.remoteRoot);
        switch (command) {
            case 'plan': return await cmdApply(ctx, args, true);
            case 'apply': return await cmdApply(ctx, args, false);
            case 'rollback': return await cmdRollback(ctx, args);
            case 'list': return await cmdList(ctx);
            case 'restart': return await cmdRestart(ctx, args);
            case 'prune': await prune(ctx, flags.has('--apply'), null); return 0;
            case 'purge': return await cmdPurge(ctx);
        }
        return 2;
    } catch (e) {
        if (e instanceof UsageError || e instanceof ConfigError) { log.error('error: ' + e.message); return 2; }
        log.error('error: ' + (e && e.message ? e.message : String(e)));
        return 1;
    }
}
