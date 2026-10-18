# DS-DIST-R2 — Local manual editorial evidence

Date: 2026-09-29. Scope: Distribution Hub only, with a dedicated test-world
operator and Distribution database on local PostgreSQL port 5442. No staging or
production database, provider, publishing channel or deployment was used.

## Implemented and tested

- Immutable, timecoded transcript versions retain original text. Corrections
  create a new child version without inherited approval.
- Human transcript and exact-quote decisions are immutable and revision-bound.
  Exact quotes pin the reviewed transcript, source checksum, segments and times.
- The HTTP read model separates historical review from current quote eligibility.
  Corrections, rejected source reviews, source replacement and withdrawal prevent
  reuse of earlier approvals. Commands recheck current dependencies.
- Manual source-context playback, transcript import/correction, quote selection,
  human review and glossary authoring are connected through scoped operator APIs.
- Every persistent operation is test-world scoped. Separate migration/runtime
  credentials and append-only runtime grants protect immutable editorial records.

## Verification log

1. Domain rules and contracts were exercised by their own suites. The repository
   integration suite passed the six added R2 PostgreSQL scenarios: original-text
   retention; concurrent corrections/reviews; exact-quote and human-review gates;
   stale source/withdrawal; capability and world isolation; glossary history.
2. Eight editorial HTTP tests passed, including unauthenticated requests, stale
   source commands, forged provenance/reviewer rejection, and historical quote
   approval invalidation. Distribution-web TypeScript compilation passed.
3. `tests/e2e/distribution-editorial.spec.ts` passed on Chromium (6.0 seconds) and
   WebKit (7.7 seconds), both in 14.4 seconds. The test uses a generated, silent
   four-second WAV and explicitly synthetic text; nothing is attributed to
   Sri Swamiji. It exercises upload → timed text → human approval → exact quote
   → quote approval → source-context playback → correction → historical
   approval retained but eligibility denied. Stale reapproval returns HTTP 409.
4. Both browser engines passed widths 320, 390, 768, 1024 and 1440 pixels with no
   horizontal page overflow and editorial controls at least 44 pixels high.
   Screenshots were saved under `/private/tmp/distribution-r2-browser`; WebKit
   390px and Chromium 1440px screenshots were visually inspected for clipping,
   contrast, readable labels and action grouping.
5. Scoped Biome and TypeScript checks passed. Failed preliminary runs exposed
   test-selector assumptions, login-throttle reuse and an in-place build restart;
   selectors/session reuse were fixed and both complete runs passed against a
   frozen build. No product defect was concealed by a test retry.

## Limits and remaining R2 exit evidence

This proves the **manual, human-reviewed editorial path** on local browser
engines. It does not certify native iOS/Android apps or physical devices.
No ASR/translation/model provider has been called or qualified. No model
comparison or owner-approved golden-corpus evaluation has been performed.
In particular, the required critical-glossary error rate below 1% has **not**
been measured; zero samples is unknown, not a passing score. Automated content
intelligence remains unqualified. Publishing is not activated by this work.

Nothing was committed, pushed or deployed.
