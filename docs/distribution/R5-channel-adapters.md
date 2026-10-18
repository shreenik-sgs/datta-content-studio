# R5 channel publishing boundary

This slice adds tested publishing policy, resumable YouTube transport, and Telegram channel text transport. It does **not** turn on automated distribution. No channel credentials, live provider requests, uploads, posts, or background scheduling were used. Migration 0009 adds TEST-only rehearsal tables and was exercised on disposable local databases. Existing Manual Export remains the operational delivery path.

## Implemented behavior

- An immutable activation revision, destination account, and TEST/PRODUCTION world identify one publication. Reusing the identity with a different approved-payload checksum is refused.
- A repository can claim work with revision compare-and-swap and an attempt ID. A repeated attempt returns `dispatch: false`; another concurrent attempt is refused. Claims must be committed before calling the provider.
- Every mutating provider operation rereads a caller-supplied dispatch policy. Verified account/adoption evidence, current content/CTA/derivative/native approvals, rights, quota, audience authorization, emergency stop, and circuit state must all allow dispatch. Policy snapshots older than five seconds or from the future are refused.
- Automatic direct messages are refused. Public-channel authorization is not represented as an individual devotee's communication consent. Direct delivery requires the separate versioned purpose-specific consent contract before adoption.
- Confirmed receipts identify the remote publication and destination. Unknown outcomes and expired worker leases enter reconciliation and cannot be claimed as new sends. Explicit rate-limit rejections wait for the provider delay; automatic attempts are bounded at five.
- Transport credentials and provider bodies are never returned in errors. Responses are bounded to 64 KiB and requests have a 60-second deadline. HTTP redirects are refused. Fetch is mandatory injection; there is no global-fetch fallback.

## Provider behavior

**YouTube:** explicit title, description, language, category, privacy, made-for-kids and synthetic-media declarations are required. Subscriber notifications are disabled. The session is returned before any media bytes are sent; persist it privately first. Media is limited locally to a 100 MiB MP4 artifact and its SHA-256 is checked before upload. The adapter sends remaining bytes only to the exact approved Google resumable endpoint and verifies returned channel and privacy. After timeout, interrupted upload or 5xx, query the persisted session with an empty PUT and use the provider's byte offset. Expired sessions or lost session identifiers require operator reconciliation before any replacement upload.

This follows Google's [resumable upload protocol](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol). A successful upload response confirms receipt, not completion of YouTube processing or public availability; those lifecycle checks still need integration. The [videos.insert reference](https://developers.google.com/youtube/v3/docs/videos/insert) also requires authorized scope and notes that unverified API projects can be restricted to private uploads. Production adoption must verify the actual account/project, scopes and current quotas; no quota constants or claimed eligibility are inferred here.

**Telegram:** this slice posts only reviewed plain text, including its approved tracked destination, to an explicitly verified numeric channel ID. It disables paid broadcast, link previews and notification sounds. The returned message must match the intended channel and exact text. An explicit Bot API rejection can permit a delayed retry; a timeout, malformed success, proxy rejection or 5xx does not.

The [official Bot API](https://core.telegram.org/bots/api#sendmessage) documents successful message receipts and `retry_after` for flood control. It does not document an idempotency key for `sendMessage` or a lookup for an unknown sent-message ID. Therefore Telegram uncertain sends return `MANUAL_RECONCILIATION`; the adapter neither repeats them nor consumes `getUpdates` to infer failure. Automatic recovery of these sends is **not** claimed as a passed R5 exit gate. Telegram video/file delivery is outside this text-post slice.

## Durable local rehearsal

`createDistributionChannelRepository` stores account verification metadata and secret references, never OAuth or bot secrets. Channel administrators append account revisions; authorized publishers approve immutable target-channel rehearsal plans derived from existing governed Manual Export activations. It does not relabel an existing manual activation as a live channel release.

Operators can claim a rehearsal, record a synthetic result, recover an expired lease, and read bounded local status. PostgreSQL transaction locks, unique publication identities, append-only revisions and expected revisions serialize competing workers. Runtime grants permit SELECT/INSERT only on all four channel tables. Changed approved payloads, account revisions, stale source/native approval and stopped activations are refused. A committed claim that loses its process recovers to reconciliation, never a new send.

Every returned plan/claim carries `networkEnabled: false` and `mode: LOCAL_SIMULATION`; database constraints also require TEST and simulation-only records. Simulated successful receipts are explicitly marked with fixture IDs. No worker imports this repository for dispatch, no adapter is invoked, and no actual credential resolution occurs. The status list excludes account secret references and upload sessions. Native teaching revalidation reuses the existing governed render inspection rather than copying its approval logic.

## Required integration before enabling R5

1. Promote the proven local rehearsal repository to a separately reviewed live-dispatch design, with bounded reconciliation scheduling, dead-letter review and protected upload-session storage. The current tables deliberately enforce TEST-only, simulation-only rows and cannot be used to represent live delivery. Protect real upload-session URIs like credentials; do not expose them in operator lists or logs.
2. Connect governed publication plans to the transport policy callback and approved payload builder. Local claim revalidation is implemented, including source/artifact/native/campaign/CTA/activation/account revisions and target-channel rights. Live dispatch still needs a fresh destination contract, provider quota evidence and policy read immediately before every network mutation. Do not accept a browser-supplied `activationAllowed` boolean.
3. Implement account connection, least-privilege OAuth or bot credential storage/refresh/revocation, verified destination discovery, project/account eligibility evidence, expiry warnings, quota health and provider circuit controls. These transports do not acquire or refresh tokens.
4. Implement calendar/job controls and a capability-scoped operator reconciliation flow. Capture a verified existing remote receipt to resolve uncertain sends. A replacement after uncertainty needs explicit operator evidence that duplication has been considered; an empty provider search is insufficient proof of absence.
5. Obtain authorized accounts and approved TEST destinations, perform a controlled private-channel contract exercise, and prove duplicate-job/worker-crash behavior against the repository. Fake-response tests establish local protocol behavior, not provider-account adoption.
6. Add publication/processing status verification and takedown policy. A transport receipt does not imply an approved derivative is publicly playable or that takedown has succeeded.

The worker entry point imports none of these transports. No new dispatch queue or enabled feature flag is installed by this slice. Rollback remains stopping activation dispatch/opening the provider circuit and using Manual Export; reconciliation records must survive rollback.

## Verification

`packages/distribution-domain/src/channel-publishing.test.ts` covers adoption, current policy, direct-delivery refusal, identity conflict, duplicate and concurrent claims, timeout/crash recovery, rate limits, stops after enqueue, retry limits, terminal receipts and immutable upload checkpoints.

`packages/distribution-contracts/src/channel-publishing.test.ts` covers strict payloads, numeric channel destinations, explicit privacy and rejection of unsupported send options.

`apps/distribution-worker/src/channel-adapters.test.ts` injects all HTTP responses and covers resumable session creation, checksum validation, authoritative offsets, lost-response reconciliation, expired OAuth/session, destination/privacy drift, URL restrictions, Telegram uncertainty, rate limits, emergency stops and malformed/oversized results. No test contacts YouTube or Telegram.

`packages/distribution-db/src/channel-repository.integration.test.ts` creates a disposable local database, applies all Hub migrations, uses separate migration/runtime roles, and drives genuine source/transcript/artifact/activation approvals. It verifies concurrent claim exclusion across independent pools, preparation idempotency, crash/timeout recovery after restart, stops/revoked grants, source and native/transcript approval invalidation, TEST isolation, append-only privileges and explicitly synthetic receipts. Local leases can be configured from one to ninety seconds for deterministic rehearsal; live transport scheduling remains absent.
