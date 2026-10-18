# Live channel curation

The optional live-curation worker follows up to two channels from the **same YouTube channel configuration used by Practices**. It reads that configuration through the signed, read-only `studio-live-channels` v1 contract. It does not change room broadcasting, LiveKit, YouTube OAuth or Go Live settings.

## Curator and approver experience

Open **Content → Start New Curation → Curate live programs**, or **Admin → Settings → Curation & Publishing → Live channel monitoring**. Select the channels, primary spoken language, rights holder and actual authorization covering future broadcasts once. Confirm the authorization and start monitoring. Existing channels can be paused individually. Unselecting a previously enabled channel in the setup form pauses it.

A broadcast appears as **one bundle** under **Continue Existing Curation → Live broadcasts**. Open it to see all available Shorts together. Opening a recording’s workflow provides the existing six steps, source permissions, corrections and approval. Curators configure capture; approvers can review bundles. Combined-role users retain the same workflow. No capture or generation action grants approval or triggers publication.

The first section normally becomes eligible for analysis after ten minutes of captured video. This is followed by transcription, message selection, English translation, rendering and AI review; that processing takes additional time. Later sections are queued while the broadcast continues. No fixed number of Shorts is promised: only complete, supported teachings that pass review are retained. Sections with no suitable teaching are identified as checked/skipped. Provider, transcription or media failures remain failures, never disguised as a successful empty review.

## Capture and content guarantees

- Muxed H.264/AAC HLS is supported. Private transport-stream fragments are persisted before advancing the sequence cursor. An atomic local publication or conditional S3 write prevents a crash from exposing a partially written fragment.
- Ten-minute sections share three minutes of look-ahead. Only teachings beginning in the section’s owned interval may be selected. Both plan and rendered-output validation enforce that boundary; the next interval owns later beginnings. Independent AI review must still establish a complete beginning, conclusion, faithful translation and context.
- A worker restart resumes persisted sequence numbers. Repeated manifests do not duplicate saved segments. A source section and its cursor update commit together; generation is queued once per section. Raw fragments are removed only after they are no longer required by the overlapping sections.
- Missing segments, stream discontinuities and unsupported encryption are not stitched together. Affected broadcasts show a concrete recovery message and retain existing recordings/reviews. Import the complete authorized archive to recover missed footage. Enabling a monitor does not promise to recover earlier footage outside the available live window.
- Primary output is an English-captioned YouTube Short with the Hub’s saved branding, audio, typography and closing rules. Original speaker footage is the default. Generated imagery is optional and must improve understanding.
- Current curator authority, source permission validity and the enabled Practices channel are checked during operation. Pausing or changing monitoring invalidates an outstanding capture lease. Generation pauses for disabled/blocked monitors. Original sources and prior reviews are retained.
- Google login/CAPTCHA is not bypassed. Live capture reports a verification/access block. The existing verified **archive import** and authorized-file upload remain available after the broadcast. An interactive verification session for an active live stream is not part of this addon.

## Installation and operation

Apply distribution migration **0018** and reapply `packages/distribution-db/ops/runtime-grants.sql` using the existing migration role before enabling the addon. Core needs the new signed channel-list endpoint; no core database migration is introduced.

Set `STUDIO_LIVE_MONITOR_ENABLED=true` in the Hub web, capture/import worker and generation worker for the intended environment. Leave it absent/false to keep the addon off. Existing Hub/stage/worker switches and publication controls still apply. The normal `imports` or `all` worker mode runs capture; `generation` or `all` queues and generates the section packages. Two leased capture lanes prevent slow discovery on one channel from blocking the other. Keep the configured yt-dlp, FFmpeg and FFprobe executables available. Generation continues to use the existing configured Sarvam/Gemini providers.

The UI checks a world-specific worker heartbeat; an environment flag alone cannot claim the service is running. A stopped worker becomes unavailable after 90 seconds. Monitor rows expose last-check time and sanitized failure codes, never media URLs or credentials. Logs use `studio.live.error` with sanitized codes.

Private fragments use `distribution/live/<broadcast-id>/<sequence>.ts` beneath the configured local root or the existing S3 world prefix. The task needs private S3 read/write/delete permission on the new `distribution/live/` path beneath its own world prefix, in addition to existing master/output permissions. Verify the deployed IAM policy before enabling capture. Do not expose raw fragments publicly. Local and deployed environments have separate databases, channels, consent records and storage prefixes. Long broadcasts consume storage for retained source sections and derived outputs; they are not free streaming relays.

## Acceptance evidence and remaining real-world check

Local checks cover the signed channel contract, curator/approver UI, source ownership intervals, invalid HLS/URLs, private fragment integrity, actual FFmpeg audio/video remuxing, restart/repeated-manifest recovery, world separation, stale leases, permission expiry/revocation, idempotent queueing and the absence of automatic approval/publication. PostgreSQL integration tests use disposable databases on port 5442, not user data.

On 15 October 2026, read-only discovery reached both existing official channel defaults and found neither broadcasting. A real active broadcast, complete generated Short and human review are still required as live-service acceptance. Local capture is available for curator setup; no future-broadcast authorization is fabricated. Staging and production are not enabled by the local installation.

Local acceptance completed on 15 October: the compiled core and Hub builds succeeded; `pnpm check` passed with 4,440 tests (566 integration/optional tests skipped by the default gate), and the explicitly enabled Studio/live PostgreSQL suites passed 44 tests. Signed-in Chromium and WebKit checks covered desktop/mobile setup, current worker availability, both Practices channel names, keyboard access and entry links. A signed-in combined Curator/Approver fixture retained one six-step workflow and could see the finished Oct 12 Short. Pure Approver setup restrictions are covered by UI and repository tests. No monitoring authorization, broadcast fixture or publication was added to the user's local workspace. All 20 existing curation packages were preserved.
