# Datta Content Studio

An independent workspace for turning authorized recordings and playlists into
channel-specific content, reviewing it and publishing approved outputs.

- Content Curator: import/upload masters, configure a playlist once, generate and correct drafts.
- Content Approver: review, return with comments, approve and publish.
- An account may hold both workflow roles. Administrative access manages channel settings;
  administrator status alone does not grant approval or publishing.

Generated media retains the configured **@sgsswamiji** branding. The application
is independent of SGS Datta Sannidhi: it has its own accounts, session cookie,
database access and deployment. No Sannidhi login or user database is required.

## Local setup

Requires Node 22+, pnpm 9.15, PostgreSQL, FFmpeg/FFprobe and the optional configured
AI services. The renderer and YouTube import requirements are documented under
`docs/distribution/`. Use a **new database** and private storage outside the checkout.

1. `pnpm install --frozen-lockfile`
2. Copy `.env.example` to a private `.env` and set the two database URLs to the new
   Content Studio database. Load these variables in the shell (the worker and CLI
   do not implicitly load dotenv files). For local testing set the Hub stage to
   `TEST` and its enabled flag to `true`. Publishing stays off.
3. Run `pnpm db:migrate` as the database migration owner before starting services.
   Use a separate database login for the web application and workers. After each
   migration, apply `packages/distribution-db/ops/runtime-grants.sql` as the owner,
   passing that login's name as the psql variable `distribution_runtime_role`.
   Set `DISTRIBUTION_DATABASE_URL` to the restricted runtime login and
   `DISTRIBUTION_MIGRATION_DATABASE_URL` to the owner login. Supply the owner URL
   only to migration and account-provisioning commands, never to web/worker services.
4. Create a local account with `pnpm user:create`, supplying `STUDIO_USER_EMAIL`,
   `STUDIO_USER_NAME`, `STUDIO_USER_PASSWORD` and comma-separated `STUDIO_USER_ROLES`
   through a private environment file. The password must have at least 12 characters.
   Supported roles are `CONTENT_COORDINATOR` (displayed as Content Curator),
   `CONTENT_APPROVER`, and `SUPER_ADMIN` (settings administrator). The command never
   overwrites an existing account. It uses the migration owner URL to provision
   operators and grants. Remove the password variable after creation.
5. Run `pnpm dev`; open http://localhost:3070/distribution. Configure your private
   storage and provider keys, then enable generation and run `pnpm worker`.

The cookie is `dcs_session`, scoped to `/distribution`, HTTP-only, SameSite=Lax,
and secure on HTTPS. Passwords are salted with scrypt; database sessions store
only token hashes. Login is throttled per normalized email. Workers recheck current
roles in this database before acting. Sannidhi cookies are never accepted.

## Settings and deployment

Channel credentials, upload limits and rendering settings live under the Studio's
Settings screen. Gemini/Sarvam keys, service enablement and signing/encryption keys
belong in **this app's** environment/secret store. There are no links back to the
Sannidhi administration screens. YouTube bot verification remains the existing
worker verification service; deploy that service on Studio's own origin/resources.

This repository's CI validates and builds. It has **no automatic deployment** and
no access to Sannidhi's production environment. The Dockerfile builds standalone
Hub web, worker, renderer, verification and migration images. A separate AWS
stack/origin must be provisioned before cloud use. The files under `migration/`
are historical references, never a deployment configuration for the new app.

`pnpm check` runs lint, TypeScript and the unit/regression suite. `pnpm build`
builds the applications. The independent identity integration tests use only an
explicit disposable `content_studio_separation_test_*` database.
The full repository integration suite also requires `DISTRIBUTION_RUN_DB_TESTS=1`
and `DISTRIBUTION_TEST_ADMIN_URL` pointing at that disposable local instance. It
creates its own temporary databases and restricted roles, and refuses the former
Sannidhi database target. CI runs both suites against its own PostgreSQL service.

## Existing content and account migration

Source was preserved from commit `8b41ce4b` of Datta-Sannidhi-NewGen, including the
later curation and verification changes. Existing masters, derived media, review
history and credentials have **not** been copied or deleted. Migrate only the Hub
schema/media after backup and inventory verification. Existing content actor IDs
must be explicitly mapped to new operators; do not auto-link accounts by email or
copy Sannidhi sessions/passwords. Uncommitted recovery work is separately backed up
in the original local workspace and has not been silently substituted for this
newer committed source.

The additional Hub fixes from `feat/gurubhavana-series-closing-20261018` were
imported from a consistent snapshot, subsequently committed as `6e9da508` in the
source worktree on 18 October 2026. File hashes and source
provenance are recorded in `migration/source.json`; the original worktree and its
video-processing jobs remain untouched.

The latest Hub fixes through source commit `c74f881a` are now included: finished-video
audio boundary checks, safer portrait framing, 20 GiB online masters, resumable
capacity-limited transcription, bounded per-section rate-limit recovery, and clearer
progress messages. Their source commits and file hashes are recorded in
`migration/source.json`. Run the standalone `0023_large_online_masters` migration
before using the larger online-master capacity; `0022` remains the independent
operator identity migration. No accounts, provider secrets, or generated videos
are included in this source-code import.
