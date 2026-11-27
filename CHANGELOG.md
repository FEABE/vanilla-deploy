# Changelog

## 0.1.0 - 2026-11-27

First release, extracted from a hand-written deploy script that had been in daily use and generalised into a standalone, configurable CLI.

- `plan`, `apply`, `rollback`, `list`, `restart`, `prune` and `purge` commands. Each one is a dry-run until you pass `--apply`.
- Diffs git blob hashes of local `HEAD` against the server's files and the per-target deploy record. Detects drift (files changed on the server).
- Transfers only changed files as an in-process tar stream built from git blob bytes, then verifies every sent file by hash. The deploy record is written only after a successful check.
- Backs up overwritten and deleted files, plus the lists of created files and folders, under a deploy id. `rollback <id> --apply` restores exactly the state before that deploy.
- Prunes old backups (`keepDays`, never the newest `keepMin`).
- Restarts the systemd units of changed targets (`user`, `system`, optional `sudo -n`, or `none`), waits for a new main PID and an optional health URL, and restarts `restart.last` units at the end.
- Optional Cloudflare purge, by URL or everything. The token is read from an env var only and redacted from errors.
- ssh with `-F none`, an explicit key and `BatchMode`. Retries only on drops before key exchange, with exponential backoff.
- Validates paths (no `..`, control characters or backslashes) and quotes everything sent to the remote shell. Rejects unknown config keys.
- Falls back to `sha1sum` hashing on servers without git.
- Local bash transport for tests and mounted folders. The test suite needs no server.
