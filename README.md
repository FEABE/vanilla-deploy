# vanilla-deploy

Deploy the committed `HEAD` of one or more git repos to a server over plain ssh. It is a dry-run unless you pass `--apply`, only changed files are sent, every write is checked by hash, and each deploy can be rolled back with one command.

Zero dependencies: Node.js built-ins plus `git` and `ssh` on your machine, and `bash` + `tar` on the server. There is no agent, daemon or package to install on the server.

[한국어 README](README.ko.md)

```
$ vanilla-deploy plan web
vanilla-deploy 0.1.0 -> deploy@203.0.113.10:22 /srv/example
web -> web  (local 3f2a9c1, deployed 8be01d4 in 20261120-101500)  +1 ~2 -1  same 214
  + public/img/new.svg
  ~ public/app.js
  ~ server/routes.js
  - public/old.css

dry-run: nothing was changed. To deploy: vanilla-deploy apply web --apply
restart: example-web.service
cache: 3 cached file(s) change - purged after the deploy
```

## How it works

1. **Plan.** It reads the blob id of every file in the local `HEAD` tree with `git ls-tree`. On the server, one bash script hashes the matching files the same way git does and reads the deploy record left by the last deploy. The difference between the two is the plan: files to add, update and remove, plus *drift* (files that were changed on the server since the last deploy).
2. **Back up.** Before anything changes, files that will be overwritten or deleted go into `.deploy/backups/<id>/<target>.tgz`. The tool also records which files and folders will be new, and keeps the previous deploy record.
3. **Transfer.** Only added and changed files are sent, as a tar stream piped through ssh into `tar -xf -`. The tar is built in-process from git blob bytes, so no local `tar` is needed and no line endings are converted.
4. **Verify.** Removed files are deleted, then every sent file is hashed on the server and compared with its blob id. The new deploy record is written only if all of them match.
5. **Restart.** The systemd units of the targets that changed are restarted (`--user` or system). The tool then waits for each unit to be active with a new main PID and for its health URL to answer 2xx/3xx.
6. **Purge** (optional). Changed cacheable files are purged from Cloudflare, by URL.
7. **Prune.** Backups older than `backups.keepDays` are deleted. The newest `backups.keepMin` are always kept.

### Why blob hashes and not mtime

mtime says when a file was touched, not what it contains. Checkouts, rebases, `git stash`, copying and unpacking all reset it, so mtime-based tools (rsync without `--checksum`, many deploy scripts) either resend everything or miss real changes. Git already has a content id for every committed file: the blob sha. Hashing the server copy the same way (`git hash-object --no-filters`, or sha1 over `"blob <size>\0" + bytes` when the server has no git) gives an exact answer to "are these bytes the same?". One hash pass covers three jobs:

- **Diffing:** a file is sent only if its bytes differ.
- **Verification:** after the transfer, every file must hash to its blob id.
- **Drift detection:** the deploy record holds the hashes this tool wrote, so a file edited on the server by hand is caught before it is overwritten.

Only committed content is deployed. Uncommitted edits and untracked files (`.env`, local data) never leave your machine.

## Quick start

```sh
# 1. put the tool somewhere and make it callable (Node.js 22+)
git clone <this repo> vanilla-deploy
node vanilla-deploy/bin/vanilla-deploy.mjs --help     # or: npm link inside the folder

# 2. in the folder that will hold your deploy config
cp vanilla-deploy/deploy.config.example.json deploy.config.json
#    edit ssh, remoteRoot, targets

# 3. look before you leap
vanilla-deploy plan all
vanilla-deploy apply web               # rehearsal: same as plan
vanilla-deploy apply web --apply       # do it
vanilla-deploy list                    # deploy ids
vanilla-deploy rollback 20261127-093000            # what would be restored
vanilla-deploy rollback 20261127-093000 --apply
```

Server prerequisites: a user that can write `remoteRoot`, bash 4+, tar and gzip, coreutils (`sha1sum`, `cut`, `sort`, `paste`, `mktemp`), and git if you prefer `git hash-object` (optional). `curl` is needed only if you use health URLs, and systemd only if you restart units.

## Commands

| Command | What it does |
|---|---|
| `plan <target...\|all>` | Shows what would change. Never writes anything (`--apply` is refused). |
| `apply <target...\|all> [--apply]` | Without `--apply`, prints the same plan as a rehearsal. With `--apply`: backup, transfer, verify, record, restart, purge, prune. |
| `rollback <id> [--apply]` | Restores exactly what deploy `<id>` overwrote or deleted, deletes the files and empty folders it created, and restores the previous deploy record. Then restarts the units of that deploy and purges its cached files. |
| `list` | Targets, the current deploy record per target, the last 10 deploy ids, unit states. |
| `restart <target...\|all> [--apply]` | Restarts the targets' units and waits for health, without deploying. |
| `prune [--apply]` | Deletes backups older than `keepDays`, always keeping the newest `keepMin`. |
| `purge [--apply]` | Purges the whole Cloudflare zone cache. |

Options:

| Option | Meaning |
|---|---|
| `--apply` | Act. Every command that changes something is a dry-run without it. |
| `--allow-dirty` | Deploy `HEAD` even though the work tree has uncommitted changes (they are still not deployed). |
| `--force` | Overwrite drifted files (they are backed up first). For `rollback`: roll back a deploy that is not the latest for its targets, or one already rolled back. |
| `--no-restart` | Skip unit restarts. |
| `--no-purge` | Skip the CDN purge. |
| `--config <file>` | Config file. Default: `./deploy.config.json`, then `./deploy.config.mjs`. |

Exit codes: `0` ok, `1` failed (the message says what to do, including the rollback command if the deploy got past the backup step), `2` usage or config error.

## Configuration

`deploy.config.json` (or `deploy.config.mjs` with `export default { ... }`, or a function returning it, if you want to compute values). Relative paths are resolved from the config file's folder, and `~` means your home folder. Unknown keys are errors, so a typo cannot quietly switch something off.

```json
{
  "ssh": { "host": "203.0.113.10", "port": 22, "user": "deploy", "key": "~/.ssh/id_ed25519" },
  "remoteRoot": "/srv/example",
  "restart": { "mode": "user", "timeoutSec": 120, "last": ["example-proxy.service"] },
  "backups": { "keepDays": 14, "keepMin": 3 },
  "targets": {
    "api": {
      "repo": "../example-api",
      "remoteDir": "api",
      "units": ["example-api.service"],
      "health": "http://127.0.0.1:8080/health",
      "exclude": ["test/**", "**/*.md"]
    },
    "web": {
      "repo": "../example-web",
      "remoteDir": "web",
      "include": ["public/**", "server/**", "package.json"],
      "units": ["example-web.service"],
      "cache": { "include": ["public/**"], "stripPrefix": "public/" }
    }
  },
  "cloudflare": { "tokenEnv": "CLOUDFLARE_API_TOKEN", "zoneEnv": "CLOUDFLARE_ZONE_ID", "urlPrefix": "https://www.example.com/" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `ssh.host` | required | Host name or IP. A leading `-` is rejected. |
| `ssh.port` | `22` | |
| `ssh.user` | required | Plain user name. |
| `ssh.key` | required | Private key file, passed as `-i`. `~/.ssh/config` is **not** read (`-F none`). |
| `ssh.command` | `"ssh"` | ssh executable, e.g. a full path on Windows. |
| `ssh.connectTimeout` | `15` | Seconds. |
| `ssh.strictHostKeyChecking` | `"accept-new"` | `"yes"` or `"accept-new"`. `"no"` is not allowed. |
| `ssh.knownHostsFile` | ssh default | Alternative known_hosts file. |
| `ssh.retries` | `8` | Attempts per connection, used only for pre-auth drops (see below). |
| `remoteRoot` | required | Absolute POSIX path on the server. It holds all targets plus `.deploy/`. |
| `restart.mode` | `"user"` | `"user"` (`systemctl --user`, sets `XDG_RUNTIME_DIR`), `"system"` (`systemctl`), or `"none"`. |
| `restart.sudo` | `false` | System mode only: use `sudo -n systemctl`. Needs passwordless sudo for systemctl. |
| `restart.timeoutSec` | `120` | How long to wait for units to come up. |
| `restart.last` | `[]` | Units restarted after all others (e.g. the reverse proxy in front). |
| `backups.keepDays` | `14` | Older backups are pruned after each deploy. A pruned deploy can no longer be rolled back. |
| `backups.keepMin` | `3` | The newest N backups are never pruned. |
| `targets.<name>.repo` | required | Local folder: a git work tree, or any folder inside one (monorepo subfolders work, paths are relative to it). |
| `targets.<name>.remoteDir` | required | Folder below `remoteRoot`. Relative, no `..`, not inside `.deploy`, must not overlap another target's. |
| `targets.<name>.units` | `[]` | systemd units to restart when this target changes. |
| `targets.<name>.health` | none | URL checked from the server (`curl`) after restart. 2xx/3xx counts as up. |
| `targets.<name>.include` | `["**"]` | Globs of repo-relative paths to deploy. |
| `targets.<name>.exclude` | `[]` | Globs to leave out. A previously deployed file that becomes excluded is removed from the server. |
| `targets.<name>.cache` | none | `{ include, stripPrefix }`: changed files matching `include` are purged at `urlPrefix + path` with `stripPrefix` removed. |
| `cloudflare.tokenEnv` | `"CLOUDFLARE_API_TOKEN"` | Name of the env var holding an API token with *Zone, Cache Purge, Purge* only. The token itself never goes in the config. |
| `cloudflare.zoneEnv` | `"CLOUDFLARE_ZONE_ID"` | Name of the env var holding the 32-hex zone id. |
| `cloudflare.urlPrefix` | none | With it, purge by URL. Without it, purge everything. |
| `cloudflare.batchSize` | `30` | URLs per purge request (30 fits every plan; raise it if your plan allows more). |
| `transport.type` | `"ssh"` | `"local"` runs the same scripts with a local bash against a local folder (tests, mounted folders). |

Globs: `*` and `?` stay within one path segment, `**` crosses folders, `**/` also matches zero folders, `[abc]` and `[!abc]` are character classes, and a trailing `/` means everything below. Patterns match the whole path: `*.md` matches only top-level files, `**/*.md` matches them everywhere.

Purging is off when there is no `cloudflare` section, or when the env vars are missing. The deploy then lists the changed cacheable files, so you can purge them yourself.

### What lives on the server

```
<remoteRoot>/
  <remoteDir>/...                        your files
  .deploy/state/<target>.state           deploy record: JSON header line, then "<blob sha> <path>" per file
  .deploy/backups/<id>/manifest.json     targets, heads, units and cache paths of that deploy
  .deploy/backups/<id>/<target>.tgz      files that deploy overwrote or deleted
  .deploy/backups/<id>/<target>.saved    the list of files in the .tgz
  .deploy/backups/<id>/<target>.added    files it created (written last: marks a complete backup)
  .deploy/backups/<id>/<target>.newdirs  folders it created
  .deploy/backups/<id>/<target>.state    the deploy record before it
```

Deploy ids are UTC timestamps (`YYYYMMDD-HHMMSS`, with `-2`, `-3`, ... if two deploys land in the same second).

## Safety model

- **Dry-run by default.** `plan` never writes. `apply`, `rollback`, `restart`, `prune` and `purge` only act with `--apply`. Dry-runs do not even create `remoteRoot`.
- **Only committed content.** Files come from git objects of `HEAD`. A dirty work tree stops `--apply` unless you pass `--allow-dirty`, and even then only `HEAD` is sent.
- **Drift stops the deploy.** A file whose server bytes differ from what the last deploy wrote, or that this tool never deployed, is flagged, and `--apply` stops until you pass `--force`. Forced overwrites are backed up like any other. Server files that were never deployed and are not in your repo are never touched.
- **Every write is verified.** The deploy record is updated only when every sent file hashes to its blob id and every removed file is gone. Otherwise the deploy stops and prints the rollback command.
- **Exact rollback.** A rollback restores the overwritten and deleted files from the tarball (contents and modes), deletes the created files, removes the folders the deploy created (only if they are empty), and puts back the previous deploy record (or removes it after a first deploy). It refuses when a newer deploy has touched the same target since, or when the deploy was already rolled back, unless you pass `--force`. It also works for a deploy that failed halfway (the case the printed rollback command is for): targets the deploy never reached are skipped.
- **Paths are validated, everything is quoted.** File names and `remoteDir` must be relative paths without `..`, `.` or empty segments, without backslashes, control characters (newline, CR, tab, NUL, ...) and leading or trailing spaces in a segment. Names that fail are refused with a clear message: rename them or `exclude` them. They are never skipped silently. Everything else (spaces, quotes, `$(...)`, backticks, `;`, `&`, a leading `-`, UTF-8) is carried safely:
  - values are single-quoted for bash;
  - file lists travel in quoted heredocs (`<<'EOF'`, never expanded);
  - names given to `tar -T` are prefixed with `./`;
  - git runs with `--literal-pathspecs`;
  - everything read back from the server (deploy records, backup lists) is validated again before use.

  The tests deploy and roll back files named `$(touch pwned).txt` and `` `touch pwned2`.txt `` and check that nothing ran.
- **Config is validated.** Host, user, port, unit names, health URLs, target names and `remoteRoot` are checked before any connection. Unknown keys are errors.
- **No secrets in logs.** The Cloudflare token is read from the environment only, never printed, and scrubbed from API error text. ssh uses your key file. Nothing secret is ever part of a remote script.
- **Careful retries.** sshd on a busy or bot-scanned server sometimes drops new connections before key exchange (`kex_exchange_identification`, `banner exchange`). No remote command has started at that point, so those, and only those, are retried with exponential backoff (0.5s, 1s, 2s, ..., up to 8s, plus jitter). A connection lost while a command runs is never retried, because the command may have run halfway.

## Windows notes (PowerShell and Git Bash)

- It works from PowerShell, cmd and Git Bash. Node.js runs the tool, `git` must be on `PATH`, and `ssh` can be Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`) or Git for Windows' ssh. Set `ssh.command` to pick one explicitly.
- `-F none` is deliberate: some ssh builds (notably Git for Windows') refuse to start when `~/.ssh/config` holds a single option they do not know. Everything the tool needs is passed on the command line.
- Line endings are a non-issue. Files are sent as the committed blob bytes, so `core.autocrlf=true` on your machine changes nothing on the server.
- Long file lists are no problem: paths travel in tar streams and heredocs, not on the command line.
- The test suite and `transport.type: "local"` need Git for Windows' bash. It is found through `git --exec-path`. The WSL `bash.exe` in System32 is never used.
- Windows file systems cannot hold some names that are fine in git (`"`, `*`, `?`, `:`, ...). That only matters for the local transport. Over ssh, names go straight from git objects to the Linux server.

## Running the tests

```sh
npm test        # node --test "test/*.test.mjs"
```

No server is needed. The "server" is a temp folder, and the real remote scripts run with a local bash. A fake `systemctl` and a local HTTP server stand in for systemd and health checks. A fake `ssh` that drops the first connections like a busy sshd drives a full deploy and rollback through the ssh transport. The purge tests use a local stand-in for the Cloudflare API.

## Limits

- The server side is Linux-oriented: bash 4+, GNU or BSD tar, coreutils. It has not been tested against BusyBox-only systems.
- One deploy at a time per `remoteRoot`. There is no lock, so two people deploying at once can interleave.
- Symlinks and submodules in the repo are skipped (the plan shows how many).
- A unit counts as up when it is active with a new main PID. `Type=oneshot` units without a main PID never pass that check.

## License

MIT, see [LICENSE](LICENSE).
