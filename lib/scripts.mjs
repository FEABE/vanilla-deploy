/**
 * Remote bash scripts and parsers for their output. Pure functions: no ssh here, so the tests can run the
 * very same scripts with a local bash.
 *
 * Remote layout (everything below remoteRoot, "$R" in the scripts):
 *   <remoteDir>/...                      deployed files of each target
 *   .deploy/state/<target>.state         deploy record: line 1 = JSON meta, then "<blob sha> <path>" per file
 *   .deploy/backups/<id>/manifest.json   what that deploy touched (targets, units, cache paths)
 *   .deploy/backups/<id>/<target>.tgz    files that were overwritten or deleted (absent when none)
 *   .deploy/backups/<id>/<target>.added  files that were created
 *   .deploy/backups/<id>/<target>.newdirs  directories that did not exist before (removed again if empty)
 *   .deploy/backups/<id>/<target>.state  the previous deploy record (absent on a first deploy)
 *
 * Every interpolated value is either shq()-quoted or sent through a quoted heredoc. File names never appear
 * unquoted; they are validated (paths.mjs) before any script is built.
 */
import { shq, heredoc } from './shell.mjs';
import { assertRelPath } from './paths.mjs';

const M = '#@';   // section marker prefix in script output

/** Hash function used on the server: git when available, otherwise sha1sum over "blob <size>\0<bytes>". */
const HASH_FN = [
    'vd_hash() {',
    '  if [ -z "${VD_HASH_SHA1SUM:-}" ] && command -v git >/dev/null 2>&1; then',
    '    local L; L=$(mktemp)',
    '    cat > "$L"',
    '    if [ -s "$L" ]; then git hash-object --no-filters --stdin-paths < "$L" | paste -d" " - "$L"; fi',
    '    rm -f "$L"',
    '  else',
    '    local f s h',
    '    while IFS= read -r f; do',
    '      if [ -z "$f" ]; then continue; fi',
    '      s=$(wc -c < "$f"); s=${s//[[:space:]]/}',
    '      h=$({ printf "blob %s\\0" "$s"; cat -- "$f"; } | sha1sum); h=${h%% *}',
    '      printf "%s %s\\n" "$h" "$f"',
    '    done',
    '  fi',
    '}',
    // prints the lines of stdin that name existing regular files
    'vd_existing() { local f; while IFS= read -r f; do if [ -n "$f" ] && [ -f "$f" ]; then printf "%s\\n" "$f"; fi; done; }'
].join('\n');

export function systemctlArray(restart) {
    if (restart.mode === 'user') return 'SC=(systemctl --user)';
    return restart.sudo ? 'SC=(sudo -n systemctl)' : 'SC=(systemctl)';
}

export function prelude(remoteRoot, restart) {
    const lines = ['set -euo pipefail', 'R=' + shq(remoteRoot), HASH_FN];
    if (restart && restart.mode === 'user') lines.push('export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"');
    if (restart && restart.mode !== 'none') lines.push(systemctlArray(restart));
    return lines.join('\n') + '\n';
}

const targetDir = (t) => '"$R"/' + shq(t.remoteDir);
const statePath = (t) => '"$R/.deploy/state/"' + shq(t.name + '.state');

/** Parses "#@NAME" sections. Blank lines are dropped. */
export function sections(out) {
    const sec = {};
    let cur = null;
    for (const line of String(out).split('\n')) {
        if (line.startsWith(M)) { cur = line.slice(M.length).trim(); sec[cur] = []; continue; }
        if (cur && line !== '') sec[cur].push(line);
    }
    return sec;
}

/** Lines that the scripts prefix with "=" (raw names, so a name can never look like a "#@" marker). */
export function rawLines(lines) {
    return (lines || []).filter((l) => l.startsWith('=')).map((l) => l.slice(1));
}

/** ["<sha> <path>", ...] -> { path: sha }. Paths are validated: a tampered record cannot inject names. */
export function pairs(lines) {
    const m = {};
    for (const l of lines || []) {
        const i = l.indexOf(' ');
        if (i < 0) continue;
        m[assertRelPath(l.slice(i + 1), 'remote path')] = l.slice(0, i);
    }
    return m;
}

/** Deploy record file content. */
export function stateText(meta, files) {
    const lines = [JSON.stringify(meta)];
    for (const p of Object.keys(files).sort()) lines.push(files[p] + ' ' + p);
    return lines;
}

export function parseState(lines) {
    if (!lines || !lines.length) return null;
    let meta;
    try { meta = JSON.parse(lines[0]); } catch { throw new Error('remote deploy record is not readable'); }
    return { meta, files: pairs(lines.slice(1)) };
}

//--------------------------------------------------------------------------------------------------
// plan
//--------------------------------------------------------------------------------------------------

/** Folder state, previous deploy record, and current hashes of (local paths + previously deployed paths). */
export function infoScript(t, localPaths) {
    return [
        'D=' + targetDir(t),
        'S=' + statePath(t),
        'echo "' + M + 'MODE"; if [ -d "$D" ]; then echo present; else echo missing; fi',
        'echo "' + M + 'STATE"; if [ -f "$S" ]; then cat "$S"; echo; fi',
        'echo "' + M + 'CUR"',
        'if [ -d "$D" ]; then',
        '  cd "$D"',
        '  { cat ' + heredoc(localPaths) + '    if [ -f "$S" ]; then sed 1d "$S" | cut -d" " -f2-; fi',
        '  } | LC_ALL=C sort -u | vd_existing | vd_hash',
        'fi'
    ].join('\n') + '\n';
}

export function parseInfo(out) {
    const s = sections(out);
    const mode = ((s.MODE || [])[0] || '').trim();
    if (mode !== 'present' && mode !== 'missing') throw new Error('unexpected reply from server (no MODE)');
    return { mode, state: parseState(s.STATE), cur: pairs(s.CUR) };
}

//--------------------------------------------------------------------------------------------------
// apply
//--------------------------------------------------------------------------------------------------

/** Creates .deploy/backups/<id> (with -2, -3 ... suffix if that second is taken) and writes the manifest. */
export function beginScript(id, manifest) {
    return [
        'mkdir -p "$R/.deploy/backups" "$R/.deploy/state"',
        'ID=""',
        'for n in "" -2 -3 -4 -5 -6 -7 -8 -9; do',
        '  if mkdir "$R/.deploy/backups/"' + shq(id) + '"$n" 2>/dev/null; then ID=' + shq(id) + '"$n"; break; fi',
        'done',
        'if [ -z "$ID" ]; then echo "cannot create a backup folder for ' + id + '" >&2; exit 1; fi',
        'echo "' + M + 'ID $ID"',
        'cat > "$R/.deploy/backups/$ID/manifest.json" ' + heredoc([JSON.stringify(manifest)])
    ].join('\n') + '\n';
}

/**
 * Backup step for one target: remember new directories, tar what will be overwritten or deleted,
 * list what will be created, keep the previous deploy record. Creates the target folder.
 */
export function backupScript(t, id, plan, newDirCandidates) {
    const existing = [...plan.update, ...plan.remove];
    return [
        'D=' + targetDir(t),
        'S=' + statePath(t),
        'B="$R/.deploy/backups/"' + shq(id),
        'T=' + shq(t.name),
        'cd "$R"',
        'while IFS= read -r d; do if [ -n "$d" ] && [ ! -e "$d" ]; then printf "%s\\n" "$d"; fi; done > "$B/$T.newdirs" ' + heredoc(newDirCandidates),
        'mkdir -p "$D"',
        'cd "$D"',
        existing.length ? 'tar -czf "$B/$T.tgz" -T - ' + heredoc(existing.map((p) => './' + p)) : ':',
        'cat > "$B/$T.added" ' + heredoc(plan.add),
        'if [ -f "$S" ]; then cp -p "$S" "$B/$T.state"; fi',
        'echo "' + M + 'BACKUP ok"'
    ].join('\n') + '\n';
}

/** Remote command (not a script) that unpacks the tar stream on stdin into the target folder. */
export function extractCommand(remoteRoot, t) {
    return 'cd ' + shq(remoteRoot + '/' + t.remoteDir) + ' && tar --no-same-owner -xf -';
}

/** Deletes removed files, verifies hashes of sent files, and writes the deploy record only if all match. */
export function finalizeScript(t, plan, sentExpect, stateLines) {
    return [
        'D=' + targetDir(t),
        'S=' + statePath(t),
        'cd "$D"',
        'while IFS= read -r f; do if [ -n "$f" ]; then rm -f -- "$f"; fi; done ' + heredoc(plan.remove),
        'EXP=$(mktemp); GOT=$(mktemp)',
        'cat > "$EXP" ' + heredoc(sentExpect),
        'cut -d" " -f2- "$EXP" | vd_existing | vd_hash > "$GOT"',
        'BAD=0',
        'if [ "$(cat "$EXP")" != "$(cat "$GOT")" ]; then BAD=1; echo "' + M + 'GOT"; cat "$GOT"; fi',
        'echo "' + M + 'LEFT"',
        'while IFS= read -r f; do if [ -n "$f" ] && [ -e "$f" ]; then printf "=%s\\n" "$f"; BAD=1; fi; done ' + heredoc(plan.remove),
        'rm -f "$EXP" "$GOT"',
        'if [ "$BAD" = 0 ]; then',
        '  cat > "$S.tmp" ' + heredoc(stateLines) + '  mv -f "$S.tmp" "$S"',
        'fi',
        'echo "' + M + 'VERIFY $BAD"'
    ].join('\n') + '\n';
}

export function parseFinalize(out, sentExpect) {
    const s = sections(out);
    const ok = /^#@VERIFY 0$/m.test(String(out));
    const expect = pairs(sentExpect);
    const got = pairs(s.GOT || []);
    const mismatched = ok ? [] : Object.keys(expect).filter((p) => got[p] !== expect[p]);
    return { ok, mismatched, left: rawLines(s.LEFT) };
}

//--------------------------------------------------------------------------------------------------
// restart
//--------------------------------------------------------------------------------------------------

/**
 * Restarts units (non-blocking, all at once), then waits until each is active with a new MainPID and its
 * health URL (if any) answers 2xx/3xx. Prints "UP <unit> <seconds>" or "DOWN <unit> <state>".
 * restarts: [{ unit, health|null }]
 */
export function restartScript(restarts, timeoutSec) {
    const lines = restarts.map((r) => r.unit + ' ' + (r.health || '-'));
    return [
        'declare -A OLD',
        'while IFS=" " read -r u h; do',
        '  if [ -z "$u" ]; then continue; fi',
        '  OLD[$u]=$("${SC[@]}" show -p MainPID --value "$u" 2>/dev/null || echo 0)',
        '  "${SC[@]}" restart --no-block "$u"',
        'done ' + heredoc(lines) + 'PENDING=$(cat ' + heredoc(lines) + ')',
        'i=0',
        'while [ "$i" -lt ' + Number(timeoutSec) + ' ]; do',
        '  i=$((i + 1)); NEXT=""',
        '  while IFS=" " read -r u h; do',
        '    if [ -z "$u" ]; then continue; fi',
        '    pid=$("${SC[@]}" show -p MainPID --value "$u" 2>/dev/null || echo 0)',
        '    act=$("${SC[@]}" is-active "$u" 2>/dev/null || true); ok=0',
        '    if [ "$act" = active ] && [ "$pid" != 0 ] && [ "$pid" != "${OLD[$u]}" ]; then',
        '      if [ "$h" = - ]; then ok=1; else',
        '        code=$(curl -s -o /dev/null -m 3 -w "%{http_code}" "$h" 2>/dev/null || true)',
        '        if [ "${code:-0}" -ge 200 ] 2>/dev/null && [ "${code:-0}" -lt 400 ]; then ok=1; fi',
        '      fi',
        '    fi',
        '    if [ "$ok" = 1 ]; then echo "UP $u $i"; else NEXT="$NEXT$u $h"$\'\\n\'; fi',
        '  done <<< "$PENDING"',
        '  PENDING="$NEXT"',
        '  if [ -z "${PENDING//[[:space:]]/}" ]; then break; fi',
        '  sleep 1',
        'done',
        'while IFS=" " read -r u h; do if [ -n "$u" ]; then echo "DOWN $u $("${SC[@]}" is-active "$u" 2>/dev/null || true)"; fi; done <<< "$PENDING"',
        'exit 0'
    ].join('\n') + '\n';
}

export function parseRestart(out) {
    const up = [], down = [];
    for (const line of String(out).split('\n')) {
        const [st, unit, extra] = line.split(' ');
        if (st === 'UP') up.push({ unit, seconds: Number(extra) });
        else if (st === 'DOWN') down.push({ unit, state: extra || 'unknown' });
    }
    return { up, down };
}

//--------------------------------------------------------------------------------------------------
// rollback, list, prune
//--------------------------------------------------------------------------------------------------

export function readManifestScript(id) {
    return 'B="$R/.deploy/backups/"' + shq(id) + '\n'
        + 'if [ ! -f "$B/manifest.json" ]; then echo "no such deploy: ' + id + '" >&2; exit 4; fi\n'
        + 'echo "' + M + 'MANIFEST"; cat "$B/manifest.json"; echo\n'
        + 'echo "' + M + 'ROLLED"; if [ -f "$B/rolled-back" ]; then cat "$B/rolled-back"; echo; fi\n';
}

export function rollbackInfoScript(id, t) {
    return [
        'B="$R/.deploy/backups/"' + shq(id),
        'T=' + shq(t.name),
        'S=' + statePath(t),
        'echo "' + M + 'ADDED"; if [ -f "$B/$T.added" ]; then sed "s/^/=/" "$B/$T.added"; fi',
        'echo "' + M + 'NEWDIRS"; if [ -f "$B/$T.newdirs" ]; then sed "s/^/=/" "$B/$T.newdirs"; fi',
        'echo "' + M + 'RESTORE"; if [ -f "$B/$T.tgz" ]; then tar -tzf "$B/$T.tgz" | sed "s/^/=/"; fi',
        'echo "' + M + 'HASSTATE"; if [ -f "$B/$T.state" ]; then echo yes; else echo no; fi',
        'echo "' + M + 'CURRENT"; if [ -f "$S" ]; then head -n 1 "$S"; fi'
    ].join('\n') + '\n';
}

/** Restores one target: unpack overwritten/deleted files, delete created files and folders, restore the record. */
export function rollbackScript(id, t, added, newDirsDeepestFirst) {
    return [
        'D=' + targetDir(t),
        'S=' + statePath(t),
        'B="$R/.deploy/backups/"' + shq(id),
        'T=' + shq(t.name),
        'mkdir -p "$D"',
        'cd "$D"',
        'if [ -f "$B/$T.tgz" ]; then tar -xzf "$B/$T.tgz"; fi',
        'while IFS= read -r f; do if [ -n "$f" ]; then rm -f -- "$f"; fi; done ' + heredoc(added),
        'cd "$R"',
        'while IFS= read -r d; do if [ -n "$d" ]; then rmdir -- "$d" 2>/dev/null || true; fi; done ' + heredoc(newDirsDeepestFirst),
        'if [ -f "$B/$T.state" ]; then cp -p "$B/$T.state" "$S"; else rm -f "$S"; fi',
        'echo "' + M + 'RESTORED"'
    ].join('\n') + '\n';
}

export function markRolledBackScript(id, when) {
    return 'printf "%s\\n" ' + shq(when) + ' > "$R/.deploy/backups/"' + shq(id) + '"/rolled-back"\n';
}

export function listBackupsScript() {
    return 'echo "' + M + 'BACKUPS"; if [ -d "$R/.deploy/backups" ]; then ls -1 "$R/.deploy/backups" | sed "s/^/=/"; fi\n';
}

/** Deploy records, recent backups (with manifests) and unit states for `list`. */
export function listScript(names, units, withUnits) {
    return [
        'echo "' + M + 'STATES"',
        'while IFS= read -r t; do if [ -n "$t" ] && [ -f "$R/.deploy/state/$t.state" ]; then printf "%s " "$t"; head -n 1 "$R/.deploy/state/$t.state"; fi; done ' + heredoc(names),
        'echo "' + M + 'BACKUPS"',
        'if [ -d "$R/.deploy/backups" ]; then',
        '  ls -1 "$R/.deploy/backups" | LC_ALL=C sort | tail -n 10 | while IFS= read -r d; do',
        '    m=-; if [ -f "$R/.deploy/backups/$d/manifest.json" ]; then m=$(head -n 1 "$R/.deploy/backups/$d/manifest.json"); fi',
        '    rb=""; if [ -f "$R/.deploy/backups/$d/rolled-back" ]; then rb=" rolled-back"; fi',
        '    printf "=%s%s %s\\n" "$d" "$rb" "$m"',
        '  done',
        'fi',
        'echo "' + M + 'UNITS"',
        withUnits
            ? 'while IFS= read -r u; do if [ -n "$u" ]; then printf "%s %s\\n" "$u" "$("${SC[@]}" is-active "$u" 2>/dev/null || true)"; fi; done ' + heredoc(units)
            : ':'
    ].join('\n') + '\n';
}

export function pruneScript(ids) {
    return 'cd "$R/.deploy/backups"\nrm -rf -- ' + ids.map(shq).join(' ') + '\n';
}
