#!/bin/sh
# Probe the authenticated X socket instead of waiting indefinitely for SIGUSR1.
# Docker PID 1 signal delivery must never prevent the worker/health server starting.
set -eu
umask 077
export DISPLAY=:99
XAUTHORITY=$(mktemp /tmp/studio-xauth.XXXXXX)
export XAUTHORITY
xpid=""
worker=""
cleanup() {
  if [ -n "$worker" ]; then kill -TERM "$worker" 2>/dev/null || true; wait "$worker" 2>/dev/null || true; fi
  if [ -n "$xpid" ]; then kill -TERM "$xpid" 2>/dev/null || true; wait "$xpid" 2>/dev/null || true; fi
  rm -f "$XAUTHORITY"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cookie=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$cookie"
unset cookie
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" &
xpid=$!
ready=false
for attempt in $(seq 1 20); do
  kill -0 "$xpid" 2>/dev/null || break
  if timeout 1 xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.25
done
if ! $ready; then
  printf '%s\n' 'Verification display did not become ready; worker startup stopped.' >&2
  exit 1
fi
"$@" &
worker=$!
set +e
wait "$worker"
result=$?
worker=""
exit "$result"
