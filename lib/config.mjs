/**
 * Config loading and validation (deploy.config.json or deploy.config.mjs).
 * Unknown keys are errors, so a typo cannot silently turn a safety option off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRemoteRoot, checkRemoteDir, checkRelPath, dirsOverlap } from './paths.mjs';
import { makeMatcher } from './glob.mjs';

export const CONFIG_NAMES = ['deploy.config.json', 'deploy.config.mjs'];

export class ConfigError extends Error {}

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,254}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$|^\[[0-9A-Fa-f:.]+\]$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(msg) { throw new ConfigError(msg); }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function onlyKeys(obj, where, allowed) {
    if (!isObj(obj)) fail(where + ' must be an object');
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(where + ': unknown key "' + k + '" (allowed: ' + allowed.join(', ') + ')');
}

function strList(v, where, def) {
    if (v === undefined) return def;
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || s === '')) fail(where + ' must be a list of non-empty strings');
    return v;
}

function posInt(v, where, def, max = Number.MAX_SAFE_INTEGER) {
    if (v === undefined) return def;
    if (!Number.isInteger(v) || v < 0 || v > max) fail(where + ' must be an integer between 0 and ' + max);
    return v;
}

export function expandHome(p) {
    return p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
}

function checkHealth(url, where) {
    if (url === undefined || url === null) return null;
    if (typeof url !== 'string' || !/^https?:\/\/[^\s'"\\`$]+$/.test(url)) fail(where + ' must be an http(s) URL without spaces or quotes');
    try { new URL(url); } catch { fail(where + ' is not a valid URL'); }
    return url;
}

/** Validates a raw config object and returns the normalised form. configDir resolves relative paths. */
export function normalizeConfig(raw, configDir) {
    onlyKeys(raw, 'config', ['$schema', 'transport', 'ssh', 'remoteRoot', 'restart', 'backups', 'targets', 'cloudflare']);

    let transport = { type: 'ssh' };
    if (raw.transport !== undefined) {
        onlyKeys(raw.transport, 'transport', ['type', 'bash']);
        if (!['ssh', 'local'].includes(raw.transport.type)) fail('transport.type must be "ssh" or "local"');
        transport = { type: raw.transport.type, bash: raw.transport.bash || null };
    }

    let ssh = null;
    if (transport.type === 'ssh') {
        if (raw.ssh === undefined) fail('ssh is required (host, user, key)');
        onlyKeys(raw.ssh, 'ssh', ['host', 'port', 'user', 'key', 'command', 'connectTimeout', 'strictHostKeyChecking', 'knownHostsFile', 'retries']);
        const s = raw.ssh;
        if (typeof s.host !== 'string' || !HOST.test(s.host)) fail('ssh.host must be a host name or IP address');
        if (typeof s.user !== 'string' || !USER.test(s.user)) fail('ssh.user must be a plain user name');
        if (typeof s.key !== 'string' || !s.key) fail('ssh.key must be the path of a private key file');
        const port = s.port === undefined ? 22 : s.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail('ssh.port must be 1-65535');
        const shk = s.strictHostKeyChecking === undefined ? 'accept-new' : s.strictHostKeyChecking;
        if (!['yes', 'accept-new'].includes(shk)) fail('ssh.strictHostKeyChecking must be "yes" or "accept-new"');
        if (s.command !== undefined && (typeof s.command !== 'string' || !s.command)) fail('ssh.command must be the ssh executable');
        ssh = {
            host: s.host, port, user: s.user,
            key: path.resolve(configDir, expandHome(s.key)),
            command: s.command || 'ssh',
            connectTimeout: posInt(s.connectTimeout, 'ssh.connectTimeout', 15, 600),
            strictHostKeyChecking: shk,
            knownHostsFile: s.knownHostsFile ? path.resolve(configDir, expandHome(s.knownHostsFile)) : null,
            retries: Math.max(1, posInt(s.retries, 'ssh.retries', 8, 50))
        };
    }

    const rootWhy = checkRemoteRoot(raw.remoteRoot);
    if (rootWhy) fail('remoteRoot ' + JSON.stringify(raw.remoteRoot) + ' ' + rootWhy);

    const r = raw.restart === undefined ? {} : raw.restart;
    onlyKeys(r, 'restart', ['mode', 'sudo', 'timeoutSec', 'last']);
    const mode = r.mode === undefined ? 'user' : r.mode;
    if (!['user', 'system', 'none'].includes(mode)) fail('restart.mode must be "user", "system" or "none"');
    const restart = {
        mode, sudo: r.sudo === true,
        timeoutSec: Math.max(1, posInt(r.timeoutSec, 'restart.timeoutSec', 120, 3600)),
        last: strList(r.last, 'restart.last', [])
    };
    for (const u of restart.last) if (!UNIT_NAME.test(u)) fail('restart.last: invalid unit name ' + JSON.stringify(u));

    const b = raw.backups === undefined ? {} : raw.backups;
    onlyKeys(b, 'backups', ['keepDays', 'keepMin']);
    const backups = { keepDays: posInt(b.keepDays, 'backups.keepDays', 14, 3650), keepMin: posInt(b.keepMin, 'backups.keepMin', 3, 1000) };

    let cloudflare = null;
    if (raw.cloudflare !== undefined && raw.cloudflare !== null) {
        const c = raw.cloudflare;
        onlyKeys(c, 'cloudflare', ['tokenEnv', 'zoneEnv', 'urlPrefix', 'apiBase', 'batchSize']);
        const tokenEnv = c.tokenEnv || 'CLOUDFLARE_API_TOKEN', zoneEnv = c.zoneEnv || 'CLOUDFLARE_ZONE_ID';
        if (!ENV_NAME.test(tokenEnv) || !ENV_NAME.test(zoneEnv)) fail('cloudflare.tokenEnv / zoneEnv must be environment variable names (the values never go in the config)');
        if (c.urlPrefix !== undefined && (typeof c.urlPrefix !== 'string' || !/^https?:\/\/[^\s]+\/$/.test(c.urlPrefix))) fail('cloudflare.urlPrefix must be an http(s) URL ending with "/"');
        if (c.apiBase !== undefined && (typeof c.apiBase !== 'string' || !/^https?:\/\/[^\s]+$/.test(c.apiBase))) fail('cloudflare.apiBase must be an http(s) URL');
        cloudflare = {
            tokenEnv, zoneEnv, urlPrefix: c.urlPrefix || null,
            apiBase: (c.apiBase || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''),
            batchSize: Math.max(1, posInt(c.batchSize, 'cloudflare.batchSize', 30, 500))
        };
    }

    if (!isObj(raw.targets) || !Object.keys(raw.targets).length) fail('targets must be an object with at least one target');
    const targets = {};
    for (const [name, t] of Object.entries(raw.targets)) {
        const where = 'targets.' + name;
        if (!TARGET_NAME.test(name) || name === 'all') fail(where + ': target names use letters, digits, "." "_" "-" and "all" is reserved');
        onlyKeys(t, where, ['repo', 'remoteDir', 'units', 'health', 'include', 'exclude', 'cache']);
        if (typeof t.repo !== 'string' || !t.repo) fail(where + '.repo must be a local directory');
        const dirWhy = checkRemoteDir(t.remoteDir);
        if (dirWhy) fail(where + '.remoteDir ' + JSON.stringify(t.remoteDir) + ' ' + dirWhy);
        const units = strList(t.units, where + '.units', []);
        for (const u of units) if (!UNIT_NAME.test(u)) fail(where + '.units: invalid unit name ' + JSON.stringify(u));
        const include = strList(t.include, where + '.include', ['**']);
        const exclude = strList(t.exclude, where + '.exclude', []);
        let cache = null;
        if (t.cache !== undefined) {
            onlyKeys(t.cache, where + '.cache', ['include', 'stripPrefix']);
            const ci = strList(t.cache.include, where + '.cache.include', ['**']);
            const sp = t.cache.stripPrefix;
            if (sp !== undefined && (typeof sp !== 'string' || !sp.endsWith('/') || checkRelPath(sp.slice(0, -1)))) fail(where + '.cache.stripPrefix must be a relative folder ending with "/"');
            cache = { include: ci, stripPrefix: sp || '', matcher: makeMatcher(ci, []) };
        }
        targets[name] = {
            name, repo: path.resolve(configDir, expandHome(t.repo)), remoteDir: t.remoteDir, units,
            health: checkHealth(t.health, where + '.health'), include, exclude, matcher: makeMatcher(include, exclude), cache
        };
    }
    const list = Object.values(targets);
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            if (dirsOverlap(list[i].remoteDir, list[j].remoteDir)) fail('targets "' + list[i].name + '" and "' + list[j].name + '" have overlapping remoteDir values');
        }
    }
    return { configDir, transport, ssh, remoteRoot: raw.remoteRoot, restart, backups, cloudflare, targets };
}

/** Finds and loads the config. `explicit` is the --config value (or null to search `cwd`). */
export async function loadConfig(explicit, cwd = process.cwd()) {
    let file = explicit ? path.resolve(cwd, explicit) : null;
    if (!file) {
        for (const n of CONFIG_NAMES) { const p = path.join(cwd, n); if (fs.existsSync(p)) { file = p; break; } }
        if (!file) fail('no ' + CONFIG_NAMES.join(' or ') + ' in ' + cwd + ' (use --config <file>; see deploy.config.example.json)');
    }
    if (!fs.existsSync(file)) fail('config file not found: ' + file);
    let raw;
    if (/\.m?js$/.test(file)) {
        const mod = await import(pathToFileURL(file).href);
        raw = typeof mod.default === 'function' ? await mod.default() : mod.default;
    } else {
        try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail('cannot parse ' + file + ': ' + e.message); }
    }
    return Object.assign(normalizeConfig(raw, path.dirname(file)), { file });
}
