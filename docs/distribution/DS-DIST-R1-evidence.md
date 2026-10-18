# DS-DIST-R1 evidence — identity and canonical content

Date: 29 September 2026. Scope: local review working tree. Nothing committed,
pushed or deployed. No staging or production database was used.

## Environment and boundary

The browser accessed the existing local core at `http://localhost:3020` and
its `/distribution` proxy to the separate Hub on loopback port 3070. The core
was explicitly started against local Docker PostgreSQL on port 5442. Hub
records and its migration journal live in the separate `distribution_hub_local`
database, with different migrator and runtime credentials. Tests refused
non-loopback browser origins and non-local Docker contexts.

A dedicated `distribution-review@example.test` operator held explicit Hub
capabilities. Authentication revocation cases created separate random
`@example.test` identities, then revoked their own roles, sessions and grants
and left those identities inactive. Existing team accounts were untouched.
Session reuse avoids repeatedly exercising the password throttle; no throttle
was disabled. Local credentials and session cache are outside the repository,
with mode 0600. Neither appears in this report or screenshots.

## Verified behavior

- The core identity bridge re-reads the current session and returns only
  `version`, `id`, `roles`, `isTest`, `locale` and `displayName`, with `no-store`.
  The Hub accepts only current platform administrators with explicit Hub grants.
- Disabling the Hub, missing/invalid identity, spoofed role headers, invalid
  configured origins, identity timeouts and foreign mutation origins fail closed
  before content storage. Actual grant and role revocation return 403; account
  deactivation and session revocation return 401.
- A source can be uploaded, privately previewed, rights-confirmed, approved,
  exported and withdrawn. Byte-range preview returns the exact requested bytes.
  Export contains `master.png` and `manifest.json` with the correct checksum,
  revision and approval state. Withdrawal blocks both preview and export.
- Editing metadata invalidates the earlier approval. A stale editor receives
  409, refreshes the selected record, and can then retry against its new revision.
- Replacing the source creates immutable version 2 in DRAFT, with neither the
  old version's rights nor its approval. Approval and export are refused until
  rights are reaffirmed and a fresh approval is recorded. Scoped local database
  lookups and private-file reads verified that both version blobs remain intact.
- The seven operator language catalogues contain every current English key,
  nonempty values and safe localized errors. Sanskrit remains a content language,
  not an eighth operator-interface locale. This is structural coverage, not a
  native-speaker language review.

## Browser and layout evidence

Chromium and Playwright WebKit each passed the real content lifecycle and
metadata/version workflow. Both also passed the actual core/Hub revocation
scenario. This is six browser cases across the two engines, run in focused
batches against frozen local builds.

Library and detail layouts were measured at 320, 390, 768, 1024 and 1440 pixels:
no horizontal page overflow; all three navigation tabs remain reachable; the
standard creation and rights controls have at least a 43-pixel measured height
for the 44-pixel CSS target. Screenshot inspection caught and verified fixes
for WebKit's 21-pixel native selects and the tablet date fields overflowing the
rights panel.

Local screenshot artifacts:

- `/private/tmp/distribution-r1-browser/`: library/detail widths and withdrawal.
- `/private/tmp/distribution-r1-version-browser/`: additional version test output.

These are desktop browser-engine and viewport checks. They do not claim
physical iPhone/iPad/Android execution, native application integration, or
accessibility certification.

## Reproducible gates

The dedicated Playwright configuration has no general-suite global setup,
fixture sweep or automatic server startup:

```sh
set -a
source /private/tmp/distribution-local.env
set +a
pnpm exec playwright test --config tests/distribution.playwright.config.ts \
  distribution-content.spec.ts distribution-auth.spec.ts \
  --output=/private/tmp/distribution-r1-browser
```

Focused Vitest coverage includes the identity bridge, Hub authorization,
HTTP bounds/errors, runtime authorization order, content routes, range parsing,
archive bytes, private assets and catalogue completeness: **9 files, 61 tests passed**. Scoped TypeScript
and Biome checks passed for the acceptance tests. The R0 database-boundary
script was also hardened and rerun: unique owned disposable resources,
exact SQLSTATE 42501 assertions, and denied core/schema/journal operations.

## Remaining release limits

This receipt establishes the listed R1 local gates only. It is not a production
release approval or a claim that later Distribution slices are complete. Public
channel publishing, scheduled delivery, paid providers and production migrations
were not exercised. Separate-host deployment still needs an explicit SSO or
same-origin route; localhost cookie sharing must not be generalized by broadening
cookie domains. The owner requested that the working tree remain uncommitted.
