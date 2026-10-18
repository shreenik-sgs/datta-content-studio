# R6 analytics: local rehearsal readiness

The analytics plane is isolated from core participation accounting. A separate Hub repository ingests explicitly supplied TEST fixtures, reconciles mission metrics, and stores timestamped provider observations. Nothing in this path awards practice credit or reads the core database.

## Delivered

- Version 1 strict event envelopes with UUID event/source/consent references, pseudonymous actor keys, approved consent-basis labels, campaign/activation/content/CTA lineage, and no arbitrary text, email or phone fields. At most 500 events / 1 MB per command.
- Transactional receipts enforce both event identity and source-event identity. A retried identical batch is deduplicated; changed payloads fail atomically. Events and receipts are append-only to the runtime role.
- Mission definitions cover tracked returns, meaningful action rate, practice completion, relationship conversion and advocacy yield. Attribution requires correct ordering and matched participation. Late compensating voids invalidate historical completions. Unsupported outcome definitions display “Not recorded”.
- Reports suppress small numerator, denominator and complementary cohorts using distinct actors as well as event counts (minimum 10). The analytics reader never receives raw events or reconciliation diagnostic counts.
- Reconciliation takes a bounded maximum of 10,000 events over at most 31 days and publishes an immutable input-fingerprinted snapshot. Concurrent ingestion/reconciliation serializes per campaign. New events make existing snapshots visibly stale. The UI's relative windows use PostgreSQL time, independent of the browser clock.
- Provider observations retain provider, metric, definition version, currency, observed time and retrieved time separately. Only `manual_fixture` imports are adopted; YouTube/Telegram metric transports remain closed.
- `/distribution/analytics` has reporting windows, mission cards, provider observations and render/retention health. `analytics.view` authorizes reads; `operations.manage` authorizes commands. Existing core administrator roles, TEST/PROD worlds and current sessions remain authoritative.
- `distribution_analytics` is an additive existing-registry flag born OFF (core migration 0108). The Hub checks the versioned core policy bridge on each request and fails closed. Hub migration 0008 adds the raw-event, receipt, policy and snapshot tables. Raw events are range-partitioned on ingestion time, with an initial default partition; this SQL partition extension is intentionally explicit in the migration.

## Local verification

The dedicated DB suite migrates a disposable localhost database, grants a non-owner runtime role, and checks concurrent dedupe, immutable records, capability/world boundaries, consent envelope validation, approved definitions, exact lineage, late correction, report staleness, cohort suppression, provider clocks and policy retention. Browser acceptance in Chromium and WebKit exercises JSON import, lost-response-safe reimport, reconciliation, suppression after a correction, timestamped provider display, and 320/390/768/1440 widths. Exact consolidated counts are in `V3.2-build-handoff.md` and its verification evidence.

## Production gates still closed

This is a fixture-based rehearsal. A UUID consent reference in an operator fixture is not proof of a real devotee's consent. Signed/trusted core and link producers, purpose-specific consent validation, pseudonym key rotation/erasure policy, and live provider collection require adoption before production ingestion. Production policy creation and event/provider import are refused.

The approved TEST policy bounds accepted timestamps and raises retention alerts. It does not run unattended deletion or claim a deployed archive. Provision dated partitions, an approved raw-event retention/archive process (including S3/Athena if chosen), operational telemetry and a representative load/privacy review before enabling real collection. Canonical practice history retains its separate indefinite-retention invariant.

Roll back by setting the analytics flag OFF. Core participation processing continues independently; existing immutable analytics snapshots remain stored. No public tracking script or dispatch is installed by this build.
