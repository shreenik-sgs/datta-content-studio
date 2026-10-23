# Datta Media Studio staging

This stack is independent of SGS Datta Sannidhi and production. The application is
available at https://gbadpt.sgsdattasannidhi.org/distribution.

## Resources and isolation

Deploy `foundation.json` as `DattaContentStudio-staging` in ap-south-1. It creates
its own VPC, EC2 host, encrypted retained data volume, private versioned S3 bucket,
ECR repository and scoped instance role. PostgreSQL, web and worker listeners bind
to loopback; only the Caddy HTTPS proxy is public. Access the host using SSM, not SSH.
Production/Sannidhi ECS services and databases are not deployment targets.

Supply `Ami` as an explicit image ID. For an existing stack, read the running
instance's ImageId and retain it. Resolving an SSM `latest` image during a DNS or
branding update can unexpectedly replace the server. Inspect every change set and
reject host, volume or attachment replacements during a hostname-only cutover.

Runtime secrets are SecureString parameters under `/datta-content-studio/staging/`:
`runtime`, `postgres`, and `migration`. Never commit their values. Keep
`DISTRIBUTION_HUB_STAGE=TEST` and `STUDIO_PUBLISHING_ENABLED=false` in staging.
Hosted staging usernames require explicit `STUDIO_TEST_LOGIN_ALIASES_JSON`; local
aliases are not automatically enabled on hosted deployments. Both alias and email
use the same operator password, rate limit and role authorization.

## Separate GBADPT and DP installations

The existing single-instance stack belongs to GBADPT. Its hostname replaces
`studio-staging.sgsdattasannidhi.org`; the old DNS record is removed, with no
redirect. Existing database, media, accounts and resource identifiers remain in
place. The launch script accepts only GBADPT (and the legacy hostname for rollback),
requires the configured origin to match, and refuses DP. Resource names, credentials,
storage, backup destinations and service identifiers must be isolated for DP.

- GBADPT: `STUDIO_IDENTITY=gbadpt`, origin `https://gbadpt.sgsdattasannidhi.org`.
  Owns the Vishnu Purana masters and 95 Shorts. The owner currently keeps these
  local; a code deployment does not authorize copying media to staging.
- DP: `STUDIO_IDENTITY=dp`, origin `https://dp.sgsdattasannidhi.org`.
  Start empty, with its own operators, database and storage. No GBADPT imports or
  channel credentials. Its publishing account will be configured later.

Before activating either, test that an authenticated account/session, media ID,
asset URL and queued job from the other installation cannot access its data.
Logo selection does not replace database/storage isolation.

## Deploy and verify

1. Run `pnpm check`, commit, push and require successful GitHub CI.
2. Archive that exact commit; build immutable commit-tagged `distribution-web` and
   `distribution-studio-verification` images on ARM64. Keep previous image tags.
3. Retrieve secrets securely to `/srv/content-studio/config` with mode 0600.
   Prepare the retained volume with `host-prepare.sh` only after checking its ID.
4. Back up the database with `backup.sh`; run migrations explicitly using the
   migration account. `import-bundle.mjs` is a one-time, empty-database-only import
   of the frozen TEST bundle, with exact row and content-count checks.
5. Run `start-services.sh` with `STUDIO_IMAGE_REPOSITORY`, `STUDIO_RELEASE` and
   `STUDIO_HOSTNAME`. Both web and worker must pass health checks before success.
6. Verify sign-in and role boundaries for Curator, Approver and Admin, authenticated
   bundle access, all current media assets and unauthenticated rejection. Check
   original recording access for editing, subtitles and retained draft status.

Media migration is separate from metadata import. Verify byte size and SHA-256
against the export inventory. Count only current included outputs, not historical
revisions, when confirming the expected 95 Shorts. Preserve source recordings and
revision history; copying draft assets never approves or publishes them.
Multipart uploads must retain the whole-file SHA-256 in the `sha256` object metadata.
S3's composite SHA-256 differs from that whole-file hash. The asset reader validates
the checksum type and metadata, then hashes all downloaded bytes before serving them.
Include authenticated video range requests in migration checks; an S3 HEAD alone
does not prove the app can play an imported file.

The verification worker uses an authenticated X display with a bounded readiness
probe. Do not restore the `xvfb-run` wrapper that stalled before worker startup.
A running container alone is not a health check.

## Backup and rollback

`backup.sh` writes a PostgreSQL custom-format dump to the independent bucket under
`backups/`; daily timer backups supplement the pre-deployment backup. Retain the
previous image tags and runtime configuration. Roll back by selecting the previous
release after confirming schema compatibility. Restore a database backup into a
separate temporary database to validate it before considering any live restore.
Never overwrite existing content as part of an application rollback.
