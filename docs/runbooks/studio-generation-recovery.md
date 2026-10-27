# Intelligent Distribution Hub: generation recovery

Generation retains private checkpoints for transcription, channel drafts and rendered outputs. These are operational state, not editorial revisions or extra video copies. The curator and approver still see the same package and file versions. A successful rendered file is reused only after its saved checksum is verified. The worker checks the current role, source, rights and job lease before persisting work; final approval/publication checks remain mandatory.

Drafting runs sequentially in groups of at most four channels and one language, with earlier source selections supplied as context for later languages. The optional original audio is submitted only with the first drafting group; later groups reuse transcript and source context. Each group must pass the existing source-evidence, branding, translation and channel-coverage checks. A skipped channel is omitted consistently across languages. All 13 channels × 8 languages fit the API contracts. A retry with unchanged inputs reuses checkpoints; changed source, transcript, instructions, feedback, model or relevant editorial edits invalidate affected cached work. Rendering does not restart completed files after a later file fails.

Sarvam's job ID and stage are stored privately. Recovery can resume a known job during upload setup, start reconciliation, polling or download. An uncertain start is reported for operator investigation rather than creating a replacement paid job. A transport failure is automatically retried before a job exists only when it proves the request was not sent; ambiguous creation is never replayed. Successful transcription is retained even when drafting fails. Approved human transcripts take precedence over a cached machine transcript.

Gemini drafting and independent content review each have a bounded 10-minute request budget. The worker keeps renewing its job lease while waiting. Working drafts and review findings are checkpointed before the next paid stage. Up to three semantic correction rounds repair the failed message's channel variants while retaining other passing outputs and their captions. A missing correction identity gets one bounded structural repair; persistent omission reports its own error. Every repaired result must pass validation and independent review. These internal attempts do not become curator-visible versions.

Each semantic repair request handles one teaching and its channel variants, with only that teaching's findings and saved caption cues. Save the merged correction before starting the next teaching, so a later output-limit error cannot lose earlier work. Re-review the merged plan on resume; an internal correction is not automatically accepted.

The initial independent review also evaluates one teaching per request, with full source context and its channel variants. Selecting multiple versions of the same teaching for a curator correction plans them together; unselected messages are immutable context and cannot be duplicated or modified. Each correction batch includes only its selected channel/language identities; uneven selections never create additional variants. Retained output changes invalidate the correction checkpoint. Any specific later quality failure remains actionable even if an earlier AI pass exists. Do not bypass that failure by reusing the older pass for a layout-only change.

Gemini drafting, structural repair and independent review omit `maxOutputTokens`. They use the selected model's full output allowance instead of the former application caps of 20,000/12,000 tokens. Google's [GenerationConfig reference](https://ai.google.dev/api/generate-content?hl=en) defines this default in terms of the model's `output_token_limit`. The configured local model reported 65,536 during verification. This does not remove provider quotas, response validation, request deadlines or bounded repair attempts. Message-level repairs still avoid unnecessarily large requests.

For English outputs, substantive Sanskrit/Telugu speech must have English meaning in the subtitles, not merely Roman letters. Proper names and brief devotional greetings may remain intact. Check rendered frames as well as the saved caption language label. A policy change invalidates old plan/review caches, but does not alter already generated or approved files automatically; use selected-file correction for affected drafts.

Shorts and Reels render on a 1080 × 1920 portrait canvas. The speaker picture uses a centered 1080 × 1220 cover crop with proportional scaling; landscape side edges are cropped, never stretched. Branding/title space is compact, and timed English CC begins 16 pixels below the picture, outside the speaker's image and above platform controls. Inspect representative start/middle/end frames for each teaching because a centered crop is not automatic speaker tracking. Re-render existing drafts through the ordinary selected-file `mode: "render"` endpoint; preserve their passages, captions and copy. Approved outputs remain locked.

## Deployment

Run Distribution migration `0014_studio_generation_checkpoints` before starting new code, then apply `packages/distribution-db/ops/runtime-grants.sql`. The existing staging bootstrap performs both. Added fields: private `studio_package.generation_checkpoint` and safe `studio_generation_job.progress`. No ledger or immutable revision rows are changed. No new AWS service or public bucket is needed. The same additive migration is required for any separately authorized production rollout.

## Errors and retries

- Temporary 502/503/504 responses: bounded immediate retry; if still unavailable, the worker can defer the job.
- Temporary 429/rate limits: queue a delayed retry, respecting Retry-After. At most three job claims; cooldowns over one hour stop for operator action.
- Exhausted daily quota/credits: stop automatic retries. Check the configured API project's billing, account credits and model-specific quotas in the provider dashboard. A consumer subscription does not establish the API project's available quota.
- Authentication, billing, invalid model/request, content/recitation block: explicit error; no automatic provider switching.
- Output limit or incomplete response: explicit error distinguishing it from service downtime. Previously completed groups remain saved.
- The UI displays provider, stage, language, completed work and next retry time. Operational progress remains neutral; terminal errors use error styling.

Never log keys, raw error bodies, signed storage URLs or source text. Error classification reads bounded provider responses and keeps only safe codes and retry timing.

See the [local playlist issue register](../distribution/local-playlist-recovery-2026-10-13.md) for the observed failures, code corrections and verification status. Test-suite results do not replace checks on the actual resulting media.

## Optional independent drafting fallback

Keep fallback disabled until its quality is evaluated on representative original recordings. Configure this independent application's `STUDIO_OPENAI_API_KEY` and `STUDIO_OPENAI_MODEL` through its private environment/secret store, and enable `STUDIO_FALLBACK_ENABLED=true` only after evaluation. Content Studio does not read Sannidhi's provider settings or credentials. No key belongs in source control.

Fallback uses the original-language transcript for drafting, not audio transcription or dubbing. Only availability, temporary quota/rate-limit and timeout failures can trigger it. The worker records the actual drafting providers/models in provenance and saves fallback results for retry. Source rights, validation, branding and human review are unchanged. Content policy refusals and authentication failures do not trigger a fallback.

Before enabling: compare Gemini and the candidate on the same reviewed Telugu/Kannada/Tamil passages and Sanskrit verses, including code-switching, names, negations, speaker attribution, complete context and caption boundaries. Record accuracy, completion rate, time and cost. Never claim one provider is more accurate from successful API calls alone.

## Source suitability and exception handling (18 October 2026)

A recording that contains only music, an introduction, or an incomplete teaching may legitimately produce no suitable excerpt. The checkpointed plan retains the AI's channel-specific explanation. The worker now carries that explanation through a typed `StudioNoSuitableContentError` to safe job progress. The interface says **No suitable excerpt found**, counts this separately from generated files and links to **Review source and guidance**. It does not claim that an empty package passed review or became approved.

The bundle's recovery action skips `STUDIO_NO_SUITABLE_CHANNELS`; repeating the same source and guidance would incur cost without addressing the assessment. A curator can inspect the recording and explicitly change its guidance or use the full discourse. Unrelated recordings continue, and drafts and approved files stay intact. Temporary provider failures retain their bounded retries; authentication, uncertain paid-job creation and quality failures still require their appropriate recovery paths.

Failure diagnostics and the failed job/package state are written in one database transaction under the existing lease checks. Saving a failure does not make a second external authority call that could mask the original cause. No content is generated or approved by this error-recording operation. A lost lease cannot overwrite a newer worker's result. Unexpected exceptions become a safe error code with the interrupted stage and recovery advice; raw upstream payloads and credentials never become UI copy.

Import progress reads have a 15-second deadline and actions a 30-second deadline. A lost action response is described as unconfirmed, never automatically resubmitted. A successful action followed by a failed progress read stays successful: the interface reconnects and advises against duplicate submission. One recording's exception is isolated from the rest of the bundle.

Verification: worker, checkpoint and browser component regression tests cover saved suitability reasons, absence of automatic retries or empty approvals, safe unknown exceptions, lease loss, subsequent recordings, uncertain action responses and failed follow-up reads. Disposable PostgreSQL integration tests cover atomic diagnostics and status, authority-service failure while recording an error, stale leases, bundle retry isolation and unchanged approved packages. Actual media still requires the independent audio, caption, boundary and rendered-file checks described above.

## Blind native speech-cut check (18 October 2026)

A rendered-file audit found a Day 27 ending cut during a Kannada phrase even though the first boundary reviewer had repeated the ASR's completed rhetorical question. The transcript appeared to prime that verdict. Boundary review now receives only the exact included audio and a replay of the first/last 30 seconds, with an approximate language hint. No source transcript, neighboring text, caption, title or earlier verdict is supplied. It must transcribe only audible words, handle language switching and fail closed on uncertain or clipped completion. Context and translation remain separate source-linked reviews.

The additive `evidencePolicy: audio-only-native-boundaries-v2` identifies the new check and invalidates generation boundary/render caches without rewriting historical review records or changing approved files. Exact-range binding and all existing quality gates remain. A later adverse native-audio finding is corrected through selected-file generation, never overridden by an earlier general pass. Independent rendered-file audits recheck actual bytes and retain semantic/caption checks for the identical checksum.

Plan checkpoints track the media-review policy separately from paid draft/translation fingerprints. A resumed job reuses its draft but rechecks obsolete evidence; a newly detected cut enters the existing bounded repair loop. Manual-edit/render-only review fingerprints also include the evidence policy. An older cached pass cannot satisfy a newer check.

The normal Hub render pipeline also runs the blind check on the finished MP4's included speech, starting at file offset zero and excluding the silent closing hold. A source check or broad visual pass cannot override a clipped rendered ending. Its result gates `naturalBoundaries` in the checksum-bound presentation review; a failed file is retained as a recoverable generation finding, never returned as a finished output. This is part of ordinary Hub generation, not just the one-off series audit.

## Long online masters and misleading size skips

Day 44 remained publicly playable, but YouTube selected a 2.06 GiB video stream plus audio. The former 2 GiB ceiling made yt-dlp skip the video on stdout and continue with audio, ultimately surfacing as a missing/failed source. The online-master ceiling, streamed asset validation and database constraint now allow 20 GiB; direct uploads retain their separate administrator policy. Migration `0023_large_online_masters` must run before workers use the larger ceiling. A size skip on downloader stdout is now detected immediately and reported as `ONLINE_SOURCE_TOO_LARGE`, not privacy, verification or generic source failure. Downloads retain bounded storage, timeout, protocol and source-integrity checks.

## Speaker framing with devotional backdrops

A visual audit found that the source screener sometimes classified a single speaker with decorative stage artwork as a multi-person composite and kept the entire landscape picture. The `speaker-first-framing-v2` policy distinguishes decorative backgrounds from essential teaching imagery. It asks for a safe central speaker crop first, preserving the complete head, meaningful gestures and full-width bottom attribution. A conservative full-picture decision must identify the actual obstructing text, face, gesture or teaching image; decoration alone is insufficient. The renderer's geometry and independent final visual checks remain mandatory.

The framing policy invalidates source-screen, media-review and rendered-file caches. It does not rewrite existing drafts or approved files. Reconsider affected drafts through selected-file rendering, keeping the original passage, copy, captions and other output identities unchanged. Check the actual result; changing a prompt is not proof that every source supports a safe large portrait crop.

## Capacity recovery for shorter recordings (19 October 2026)

Days 56 and 57 Part 1 exposed a gap: Sarvam can report a terminal context-capacity failure even for a recording below the normal one-hour splitting threshold. The single-job path now falls back to sections after this confirmed failure. It checkpoints that decision, starts with sections no longer than two minutes, and retains the existing recursive reduction and completed-section reuse. A resumed job does not submit the failed whole recording again. Authentication failures, timeouts and uncertain paid-job creation cannot trigger this fallback; a minimum-size section that still fails stops with a specific error.

`STUDIO_TRANSCRIPTION_CONTEXT_LIMIT` is preserved in package failures and explained in the curator interface instead of being masked as a generic generation failure. Retry resumes saved work. Source rights, English caption accuracy, independent boundary review, final-file review and human approval remain required. This change does not regenerate completed drafts or approve content.

Regression coverage includes a confirmed failed job, a restart during section processing, uncertain/authentication failures, minimum-size failure, contiguous short-section coverage, persisted failure codes and recovery copy. Test results must be supplemented by the actual resumed recordings and finished-file audits.

### Rate limits while processing sections

The resumed recordings exposed a second edge case: a confirmed HTTP 429 rejection during job creation was treated like an uncertain creation. A rejected creation can now be retried after cooldown; ambiguous timeouts and 5xx responses without a saved job ID still cannot. Each audio-section invocation has at most three in-process rate-limit attempts, honoring Retry-After and a minimum one-minute delay. Exhausted section retries remain subject to the existing bounded job retry policy. The budget resets only for a different section, so progress across a long master does not exhaust the whole-job retry budget merely because the provider throttles successive sections. Exhausted quota, authentication failures and cooldowns over one hour still stop for their existing recovery path.

A section retry reloads its latest saved job ID and stage, retains all completed siblings, and exposes the retry time in progress. Cancellation during a known-safe cooldown remains resumable. Tests cover confirmed versus uncertain creation, reuse of the same paid job, exact cooldown timing, bounded repeated failures, completed transcript reuse and cancellation. No approval or quality gate is relaxed.

The curator progress view distinguishes a running section cooldown from a stopped job. Both queued retries and an active worker waiting for Retry-After show the saved progress and scheduled resume time in neutral styling. A failed job does not display a stale retry timestamp as a promise of automatic recovery.

## Additional teaching discovery and closing cards (20 October 2026)

For complete-message video generation, longer transcripts are inspected in five-minute sections with three minutes of surrounding context on either side. Original transcript IDs and timestamps remain authoritative. A section owns candidates that begin inside it; context lets a complete thought cross the section boundary. Each candidate still passes the ordinary content, translation, audiovisual boundary and rendered-file checks. Physical source overlaps are removed, then an independent semantic comparison rejects repeated meanings against retained and earlier selected teachings from the same recording. This improves coverage; it does not guarantee that every useful teaching is found, or deduplicate different recordings across a series.

The curator's **Find more Shorts across this bundle** action queues `mode: "discover"` for editable video packages. It appends reviewed outputs and verifies that every existing output is unchanged, including manual trims, captions, file versions and assets. Reviewed/approved packages stay locked. No additional candidate is a valid result; provider and source failures remain errors, not evidence of completed coverage. Section plans, decisions and review evidence are checkpointed so retries reuse paid work. The UI reports covered sections and accepted/repeated messages, and offers an explicit resume action after a failed discovery job.

The green `green-watch-subscribe-closing-card-v5` template adds “Watch full videos on this channel” above “Tap Subscribe”. Sri Datta Vijayananda Teertha Swamiji's full name and authentic portrait remain. The template is shared in code; already exported MP4s contain pixels and need an explicit selected-file `mode: "closing"` update. Changing the template alone does not change those files. This update preserves source passages, manual edits, English CC and illustration choices, renders a new file version and runs the normal quality checks. It never grants approval. Bundle counts and the file-review link retain existing output availability while updates are queued or running.

The owner’s 20 October destination update uses `@gurubhavanaadpt` for the Vishnu Purana Shorts. The `green-channel-watch-subscribe-closing-card-v6` card prints the package’s actual YouTube handle above the existing full name. Its portrait, green background and watch/subscribe invitation remain. Legacy v4/v5 cards without a printed destination can have their subscription metadata retargeted through the audited maintenance command before a selected-file closing refresh. A v6 card already contains its destination in pixels, so metadata-only retargeting is rejected. Never change a reviewed video’s destination evidence without rebuilding those pixels. Preserve previous assets and revisions, refresh only drafts, and verify audio identity, caption preservation, the rendered destination and draft status before delivering the new files.

Operational acceptance: protect a before snapshot; verify all retained output identities, passages, edits, captions and copy; check every replacement asset hash, portrait dimensions, duration and review evidence; inspect representative actual closing frames. Keep results as drafts. A passing code test suite is not a claim that an asynchronous series render or media transfer has finished.
# Closing-card-only recovery

The ordinary `closing` action now updates the reviewed MP4 instead of rebuilding its
source passage. It retains the exact source span, manual edit controls, artwork,
caption cues, caption files, title and description. Audio packets are copied without
re-encoding. Every pre-card frame and every subtitle-band frame is compared with the
previous export (minimum per-frame SSIM 0.995). The final card replaces only the
region above the subtitle band, so the final spoken captions remain visible.

`presentationReview.closingRefresh` records the prior asset hash/version, shared
card hash, audio hash, comparison minima and verification time. Existing AI review
findings and their dates are retained as inherited content evidence, not represented
as a newly performed AI review. Human approval remains separate and unchanged.
Explicit opening-card or illustration-timing changes still use the full rendering
and review path. A different legacy closing duration fails closed rather than
trimming or extending the saved speech automatically.

On `STUDIO_CLOSING_PRESERVATION_FAILED`, retain the existing draft and inspect the
comparison; do not bypass the check. On `STUDIO_CLOSING_TIMELINE_CHANGED`, use an
explicit editor render after reviewing the timeline. Provider failures cannot stop
a card-only update because that path does not call a speech, translation or AI service.


The `green-plain-text-closing-card-v7` YouTube template replaces the imitation
Subscribe button with “Watch full videos and subscribe on YouTube” in plain text,
followed by the actual destination handle on its own line. MP4 text is not
interactive; YouTube supplies the real Subscribe control. Preserve v6 evidence
on existing revisions and use the same selected-draft closing refresh and
preservation checks to apply v7. Never label a metadata-only change as a rendered
card update.

## Completed previews disappearing after a restart (26 October 2026)

Bhagavat Katha had three checked MP4s in its render checkpoints, but resuming after
channel changes created a later job timestamp. The preview filter incorrectly hid
all earlier renders, leaving the series showing zero files. Existing Vishnu Purana
outputs were unaffected because they were already committed drafts.

Checked MP4 checkpoints now remain viewable across queued retries and failed jobs.
Renders older than the current job are marked **Earlier render**, with their original
filename/date and a warning that settings or closing destinations may differ. They
are preview-only, never submitted, approved, exported for posting or counted as
finished drafts. Source hash, media identity, AI review and presentation evidence
are still validated; invalid or foreign-source checkpoints remain hidden. The
successful job replaces this preview surface with the normal editable draft list.

Inspect both `outputs` and `generationPreviews` when diagnosing missing videos.
The series table shows saved files before detailed progress, marks them as pending,
and explains when no playable MP4 exists yet. Do not restart generation or overwrite checkpoints just to make a
file visible. Regression coverage includes list/detail projection, failure/retry,
media access, environment separation and unchanged approval/publication gates.

### Separate full recordings from the Shorts subscription channel

A subscription target does not establish where full recordings are hosted. An optional
`youtubeClosing.fullVideosUrl` now keeps those channel identities separate. When different,
the green v8 card explicitly labels **Watch full videos** and **Subscribe**, and the posting
copy retains both links. Existing single-channel cards keep their v7 appearance.

On a resumed generation job, validated earlier preview checkpoints receive a closing-only
refresh before discovery continues. This never approves them or makes them publishable.
The old editorial timestamp is retained and the render cache fingerprint is invalidated.
The replacement copies the original encoded audio, compares all preceding frames and the
caption band, and compares the actual closing pixels with the requested template.

As of 27 October, external content maintenance is retired. Use the native
**Check closing cards and channel links** control for unapproved draft recordings,
or **Complete this series automatically** for the durable Shorts → stories →
final checks workflow. Existing active jobs finish unchanged. Do not run old
maintenance containers. See [Standalone Studio workflow](standalone-studio-workflow.md).

26 October 2026 Bhagavat Katha decision: full videos remain on `@gurubhavanaadpt`, while
subscription and posting target `@sridattavijayam`. This change is scoped to Bhagavat Katha;
it does not retarget the separate Vishnu Purana batch or alter Buffer settings.

## Portrait encoding timeout on a fractional CPU (26 October 2026)

The Bhagavat recovery worker reported `RENDER_TIMEOUT` while composing a portrait
Short. Its container had half a CPU, but the encoder used a fixed ten-minute wall
clock limit regardless of clip duration. Discovery, review and completed preview
checkpoints remained intact; this was a local encoder limit, not an AI credit error.

Portrait encoding now allows thirty times the output duration, with a ten-minute
minimum and a one-hour hard maximum. A separate five-minute watchdog consumes
[FFmpeg's structured progress stream](https://www.ffmpeg.org/ffmpeg.html#Main-options)
on a dedicated descriptor. Only advancing frame/timestamp counters renew it;
repeated status lines cannot keep a stalled encoder alive. `RENDER_STALLED` and
`RENDER_TIMEOUT` remain distinct, safe failure reasons in the database and UI.
Cancellation, output bounds and the absolute deadline still terminate the process.
Framing, English captions, audio controls, encoding quality and all AI/human review
requirements are unchanged.

After deploying the tested worker, retry only affected failed recordings using
their saved checkpoints. Do not enqueue another job while one is active or force
restart workers that are processing other recordings. A successful code test is
not proof that the failed real Short has finished: verify the resulting media and
both closing-card destinations before reporting series completion.

### Keep series polling separate from file evidence

On 26 October, the 95-file series still returned about 1.1 MB per refresh after
transcripts had been removed. AI-review reasons, presentation evidence and caption
cues accounted for most of the remaining payload. Slow transfers could exceed the
client deadline even when the server responded in under a second.

Series summaries now omit those detail-only fields and retain the latest feedback
and review note. They carry the rendered duration separately so the closing-card
hold remains included in the table. Preview selection fetches the complete package
before showing review details; a failed load is retryable and closing the modal
cancels the read. Approval preparation still fetches fresh full detail and validates
on the server. No saved evidence or media is removed. The local real-browser check
returned all 95 files in a 440 KB response and verified full evidence on opening a
preview. Keep this separation when adding more review metadata.

## Keep completed empty sections stable during recovery

Section discovery recorded empty coverage but did not reuse that completed
outcome. After a later provider or rendering failure, it could buy more correction
attempts for a section that had already exhausted its quality review. New candidates
from that repeat could then change every later duplicate-check fingerprint.

Completed suitability/quality rejections now have a separate checkpoint tied to
the source, transcript, requested outputs and guidance, retained teachings, models,
and review policies. A recovery skips those unchanged empty sections and continues
with the unfinished work. Provider, timeout and contract failures are never cached
as empty content. Changed inputs invalidate the checkpoint; no rejected excerpt
is promoted or exempted from review. Deploy worker changes only after its active
jobs have drained, preserving the existing checkpoints.

## Automatic retry after a worker update (27 October 2026)

On 27 October three Bhagavat Katha recordings failed `STUDIO_PRESENTATION_REPAIR_REQUIRED`
under worker a2cbe84 while the fix for their findings (full-picture framing and a
caption-free closing hold) was already on `main`. Deploying the fix did nothing for
them: a terminal failure waited for a curator to press retry on each recording.

The worker now records the media pipeline that failed each job
(`progress.mediaPipeline`: renderer version, final-review version, the boundary,
framing and presentation policies, and the deployed `STUDIO_RELEASE` tag when the
host passes one). At start-up, and then once a minute, a worker asks the repository
for packages whose latest job failed with one of the Studio's own media failures
(`STUDIO_PRESENTATION_REPAIR_REQUIRED`, `STUDIO_PRESENTATION_BOUNDARY_REQUIRED`,
`RENDER_TIMEOUT`, `RENDER_STALLED`, `RENDER_PROCESS_FAILED`, `GENERATION_FAILED`)
under a different pipeline, and requeues each one through the same checked request a
curator would make: the original requester's current curator role, the paused-series
rule, the source dependency and the transition rules all still apply. The retry
resumes saved checkpoints, so finished files are reused and only the failed work runs
again. Source-suitability decisions, spend caps, revoked roles and changed sources are
never retried this way.

The retry is bounded: the failed job is stamped with the pipeline that handled it
(`progress.recovery`), and a job that fails again under the current pipeline records
that pipeline, so an unchanged worker never loops. A paused series or an unreachable
authority leaves the job eligible for a later pass; any other refusal is declined for
this pipeline and left to the curator. Series workflows benefit without change: the
recovery runs before a series step, so a requeued member is judged after it completes.
`ops/staging/start-services.sh` passes `STUDIO_RELEASE` to the worker so every hosted
deploy counts as a pipeline change; a worker without the tag retries only when the
media constants themselves change.
