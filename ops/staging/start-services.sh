#!/bin/bash
# Migrations/data import are separate explicit operations before activation.
set -euo pipefail
umask 077
: "${STUDIO_IMAGE_REPOSITORY:?Required Studio ECR repository}"
: "${STUDIO_RELEASE:?Required immutable release tag}"
: "${STUDIO_HOSTNAME:?Required staging hostname}"
case "$STUDIO_IMAGE_REPOSITORY" in */datta-content-studio-staging) ;; *) exit 1 ;; esac
case "$STUDIO_HOSTNAME" in studio-staging.*) ;; *) exit 1 ;; esac
config=/srv/content-studio/config
test -s "$config/runtime.env"
grep -qx 'DISTRIBUTION_HUB_STAGE=TEST' "$config/runtime.env"
grep -qx 'STUDIO_PUBLISHING_ENABLED=false' "$config/runtime.env"
curl --fail --silent http://127.0.0.1:3070/distribution/api/healthz > /dev/null && old_web=true || old_web=false
# A retained pre-release database backup is required before replacing the web.
if $old_web; then /opt/content-studio/backup.sh; fi
for component in web verification; do docker pull "$STUDIO_IMAGE_REPOSITORY:$STUDIO_RELEASE-$component"; done
docker rm -f dcs-staging-worker dcs-staging-web 2>/dev/null || true
common=(--detach --restart unless-stopped --network host --cap-drop ALL --security-opt no-new-privileges --log-opt max-size=20m --log-opt max-file=3)
docker run "${common[@]}" --name dcs-staging-web --memory 1g --pids-limit 256 \
  --env-file "$config/runtime.env" -e HOSTNAME=127.0.0.1 -e PORT=3070 \
  "$STUDIO_IMAGE_REPOSITORY:$STUDIO_RELEASE-web"
docker run "${common[@]}" --name dcs-staging-worker --memory 5g --pids-limit 768 --shm-size 512m \
  --security-opt seccomp=/opt/content-studio/releases/$STUDIO_RELEASE/ops/import-verification-seccomp.json \
  --env-file "$config/runtime.env" \
  -v /srv/content-studio/scratch:/tmp/sgs-studio \
  -v /srv/content-studio/transcripts:/tmp/sgs-transcripts \
  "$STUDIO_IMAGE_REPOSITORY:$STUDIO_RELEASE-verification"
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3070/distribution/api/healthz >/dev/null; then healthy=true; break; fi
  sleep 2
done
$healthy
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3072 >/dev/null; then healthy=true; break; fi
  sleep 2
done
$healthy
printf '%s {\n  encode zstd gzip\n  @root path /\n  redir @root /distribution 302\n  reverse_proxy 127.0.0.1:3070\n}\n' "$STUDIO_HOSTNAME" > /opt/content-studio/Caddyfile
docker rm -f dcs-staging-proxy 2>/dev/null || true
docker run --detach --restart unless-stopped --network host --name dcs-staging-proxy --memory 256m \
  --log-opt max-size=20m --log-opt max-file=3 \
  -v /opt/content-studio/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /srv/content-studio/caddy:/data caddy:2
printf '%s\n' "$STUDIO_RELEASE" > /opt/content-studio/current-release
