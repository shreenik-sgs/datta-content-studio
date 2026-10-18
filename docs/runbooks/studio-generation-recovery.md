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
