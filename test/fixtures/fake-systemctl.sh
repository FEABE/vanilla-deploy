#!/bin/bash
# Fake systemctl for tests. Supports: show -p MainPID --value U | restart --no-block U | is-active U
# A unit with a "<unit>.broken" file in $FAKE_SYSTEMD_DIR never comes up.
D="${FAKE_SYSTEMD_DIR:?}"
args=()
for a in "$@"; do case "$a" in --user|--no-block|--value) ;; *) args+=("$a") ;; esac; done
case "${args[0]}" in
  show)
    u="${args[3]}"
    if [ -f "$D/$u.pid" ]; then cat "$D/$u.pid"; else echo 0; fi ;;
  restart)
    u="${args[1]}"
    printf '%s\n' "$u" >> "$D/restarts.log"
    if [ -f "$D/$u.broken" ]; then echo 0 > "$D/$u.pid"; exit 0; fi
    p=100; if [ -f "$D/$u.pid" ]; then p=$(cat "$D/$u.pid"); fi
    echo $((p + 1)) > "$D/$u.pid" ;;
  is-active)
    u="${args[1]}"
    if [ -f "$D/$u.broken" ]; then echo failed; exit 3; fi
    if [ -f "$D/$u.pid" ]; then echo active; else echo inactive; exit 3; fi ;;
  *)
    echo "fake systemctl: unsupported: $*" >&2; exit 1 ;;
esac
