# syntax=docker/dockerfile:1.7
# Datta Content Studio images. These targets contain no Sannidhi application.
#
#   distribution-web     default-OFF operator UI — :3070
#   distribution-worker  default-OFF local TEST render/link jobs
#   distribution-links   default-OFF independent signed-cache resolver — :3071
#   distribution-migrate explicit one-shot Hub migrations, never application boot
#
# Environment-specific settings arrive only at runtime.
# Why workers run through tsx rather than `node dist/index.js`:
# `tsc -b` emits extensionless ESM imports (`./listener`), which plain Node
# cannot resolve; tsx resolves them and compiles in memory at startup. The
# `start` scripts in those packages predate this and are not used here.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# ── manifests only: cached until a package.json or the lockfile changes ──
# Every workspace member's manifest is needed for the frozen-lockfile check.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/distribution-web/package.json apps/distribution-web/
COPY apps/distribution-worker/package.json apps/distribution-worker/
COPY apps/distribution-links/package.json apps/distribution-links/
COPY packages/distribution-contracts/package.json packages/distribution-contracts/
COPY packages/distribution-db/package.json packages/distribution-db/
COPY packages/distribution-domain/package.json packages/distribution-domain/
COPY packages/distribution-assets/package.json packages/distribution-assets/

# ── Distribution Hub: separately deployable, default-OFF operator service ──
FROM manifests AS build-distribution-web
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@satsang/distribution-web..."
COPY packages/distribution-domain packages/distribution-domain
COPY packages/distribution-assets packages/distribution-assets
COPY packages/distribution-contracts packages/distribution-contracts
COPY packages/distribution-db packages/distribution-db
COPY apps/distribution-web apps/distribution-web
COPY apps/distribution-links apps/distribution-links
ENV NODE_ENV=production
RUN pnpm --filter @satsang/distribution-web build

FROM node:${NODE_VERSION}-bookworm-slim AS distribution-web
RUN mkdir -p /etc/ssl/certs
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3070 \
    NEXT_TELEMETRY_DISABLED=1 \
    DISTRIBUTION_HUB_ENABLED=false \
    DISTRIBUTION_HUB_STAGE=OFF
WORKDIR /app
COPY --from=build-distribution-web --chown=node:node /repo/apps/distribution-web/.next-distribution/standalone ./
COPY --from=build-distribution-web --chown=node:node /repo/apps/distribution-web/.next-distribution/static ./apps/distribution-web/.next-distribution/static
COPY --from=build-distribution-web --chown=node:node /repo/apps/distribution-web/public ./apps/distribution-web/public
COPY --chown=node:node ops/hub-http-timeouts.cjs ./hub-http-timeouts.cjs
USER node
EXPOSE 3070
CMD ["node", "--require", "./hub-http-timeouts.cjs", "apps/distribution-web/server.js"]

FROM manifests AS distribution-worker
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@satsang/distribution-worker..."
COPY packages/distribution-domain packages/distribution-domain
COPY packages/distribution-assets packages/distribution-assets
COPY packages/distribution-contracts packages/distribution-contracts
COPY packages/distribution-db packages/distribution-db
COPY apps/distribution-links apps/distribution-links
COPY apps/distribution-worker apps/distribution-worker
# Rendering stays local TEST-only. Supply verified Linux ffmpeg/ffprobe binaries
# through the explicit runtime paths; do not silently use a codec lacking fd:
# protocol support. The existing localhost:5442 DB guard requires a compatible
# shared/host network namespace. Credentials and assets arrive only at runtime.
ENV NODE_ENV=production \
    DISTRIBUTION_HUB_ENABLED=false \
    DISTRIBUTION_HUB_STAGE=OFF
USER node
WORKDIR /repo/apps/distribution-worker
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

# Staging Studio renderer: Debian 13 supplies FFmpeg with the seekable fd: protocol.
FROM node:${NODE_VERSION}-trixie-slim AS distribution-studio
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/video-import \
    && /opt/video-import/bin/pip install --no-cache-dir "yt-dlp[default]==2026.8.19" \
    && ffmpeg -hide_banner -protocols 2>&1 | grep -q ' fd'
COPY --from=distribution-worker --chown=node:node /repo /repo
COPY --chown=node:node apps/distribution-worker/assets/sgsswamiji-channel-avatar.jpg /opt/brand/sgsswamiji.jpg
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_ENV=production DISTRIBUTION_HUB_ENABLED=false DISTRIBUTION_HUB_STAGE=OFF \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    STUDIO_YTDLP_PATH=/opt/video-import/bin/yt-dlp \
    STUDIO_BRAND_LOGO_PATH=/opt/brand/sgsswamiji.jpg STUDIO_SCRATCH_ROOT=/tmp/sgs-studio \
    DISTRIBUTION_FFMPEG_PATH=/usr/bin/ffmpeg DISTRIBUTION_FFPROBE_PATH=/usr/bin/ffprobe
USER node
WORKDIR /repo/apps/distribution-worker
CMD ["./node_modules/.bin/tsx", "src/studio-index.ts"]

# Opt-in verification browser lives beside the downloader, with the same network egress.
# Deploy as one Studio task per environment behind a private authenticated control endpoint.
FROM distribution-studio AS distribution-studio-verification
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/verification-browsers
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/verification-browsers
USER node
CMD ["xvfb-run", "-a", "./node_modules/.bin/tsx", "src/studio-index.ts"]

# Independent signed-cache resolver: no database, private signing key or Hub UI.
# Its current local TEST listener is loopback-only; use a shared/host namespace.
FROM manifests AS distribution-links
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@satsang/distribution-links..."
COPY packages/distribution-domain packages/distribution-domain
COPY packages/distribution-contracts packages/distribution-contracts
COPY apps/distribution-links apps/distribution-links
ENV NODE_ENV=production \
    DISTRIBUTION_LINKS_ENABLED=false \
    DISTRIBUTION_LINKS_STAGE=OFF
USER node
WORKDIR /repo/apps/distribution-links
EXPOSE 3071
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

# Explicit pre-deploy operation, built/run separately from every application.
# DISTRIBUTION_MIGRATION_DATABASE_URL is injected only into this one-shot task.
# Apply ops/runtime-grants.sql separately as migration owner after migrations;
# its distribution_runtime_role psql variable is supplied by infrastructure.
FROM manifests AS distribution-migrate
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@satsang/distribution-db..."
COPY packages/distribution-domain packages/distribution-domain
COPY packages/distribution-contracts packages/distribution-contracts
COPY packages/distribution-db packages/distribution-db
RUN mkdir -p /etc/ssl/certs
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
USER node
WORKDIR /repo/packages/distribution-db
CMD ["./node_modules/.bin/drizzle-kit", "migrate"]
