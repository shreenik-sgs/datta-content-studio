# Distribution Hub content quality rules

Owner requirements, updated 18 October 2026. These apply inside generation, before a curator submits a file for human approval. They do not replace the Content Approver.

## Meaning and natural boundaries

- Select one complete, source-supported teaching. The opening supplies its context; the ending contains its conclusion. Never cut a verse, syllable, conditional, answer or story to satisfy a duration limit.
- An excerpt cannot borrow its actor, event or motive from surrounding transcript. Reject an opening such as “After performing such a sacrifice, he…” when the selected speech does not establish the needed context. Do not fix this by inserting an absent name or fact into translated captions, artwork or the description. A harmless connector alone is not a failure when the teaching is independently clear. This failure was found during the 18 October Vishnu Purana pilot and is covered by the shared drafting/review rule.
- Check the actual excerpt's original audio and video, not only ASR punctuation or transcript timestamps. Leave a natural spoken ending. An open mouth alone is not proof of a bad cut; audible completion matters. Do not conceal an incomplete thought with a fade, freeze frame or inserted picture.
- The first reviewer sees adjacent native transcript segments and the selected excerpt. Failed physical or semantic boundaries enter the existing bounded drafting/correction loop. A delivered file is never silently dropped to evade a failed check.
- New closing cards use the green subscription design specified below: Sri Datta Vijayananda Teertha Swamiji’s authentic portrait, the intended channel name and “Tap Subscribe”. Transition over 0.4 seconds at the start of the final two seconds of speech, then retain a three-second silent, caption-free hold. Keep the original voice and every timed caption during speech. Reserve those added three seconds when planning channel duration limits. A closing card never repairs an incomplete teaching. The final reviewer checks the actual audio and last caption page, including the card interval. Historical approved renders retain their original branding and evidence.
- When repairing a long-master draft, supply the disputed source audio with absolute time offsets to the repair model as well as the reviewer. Translate clearly audible speech faithfully without overwriting stored ASR or shifting its segment IDs/times. Unresolved words require another complete passage, not a guessed translation. Bounded audio attachments share a 12 MiB total limit and are reused during a structural retry.
- Preserve the original voice and meaning. English captions translate substantive verses and speech; they are not Romanized Telugu/Sanskrit. This includes plain Roman-letter verse quotations even when an English explanation follows. A narrow deterministic check catches known phonetic verse patterns even when AI review passes; it is not a general language detector, and names and short greetings remain valid. Keep names and attribution accurate. Do not invent promises, medical effects, quotations or a call to action that the passage does not support.
- Separate actual mantra names/bija syllables from interleaved Kannada/Telugu explanation. Translate explanatory clauses into English instead of incorporating their transliteration into a fabricated quoted mantra. Do not reconstruct an expected mantra from memory. Check ambiguous passages against the actual source audio.

## Picture, typography and branding

- Deliver 1080 × 1920 portrait media with correct proportions, preserved source attribution and the current channel-specific closing branding.
- Screen the complete audiovisual excerpt for scene changes. Keep title cards, posters, slides, multi-person scenes, important source lettering and uncertain scenes in full. Never apply a blind centre crop to an entire mixed-scene recording.
- Enlarge a stable, centred speaker only in screened intervals. Preserve the complete head and important gestures. Never split the head into a separate upper strip. Preserve a bottom attribution band in full width where present. Merge adjacent intervals with identical safe framing before applying any transition margin; never insert artificial wide-view flashes between continuous safe speaker scenes. Keep conservative margins around genuinely unscreened footage.
- Keep added titles on separate thumbnails; do not add a persistent top header, name or logo during video playback. Preserve original source attribution. Use a subdued background when a landscape title card needs its full width. Place timed English captions close to the actual picture, outside the face and away from platform controls. The normal font is 72 pixels on a 1080-pixel-wide output, with each line center-aligned inside the safe caption band. Measure shaped glyphs and reduce only when necessary to prevent overflow. Keep complete words and Indic graphemes; no ellipses that discard subtitle text.
- When subtitles are embedded, initialize optional browser CC tracks as disabled, including Safari's automatic language selection. Do not stack two caption layers by default. Preserve a viewer's later explicit CC choice; without embedded subtitles, retain the default English player track.
- Compare the source excerpt and the actual encoded result, with full-resolution frame pairs at boundaries, speaker framing and supporting inserts. Model judgment is fallible; deterministic layout tests and human review remain necessary.

## Full-screen presentation and narrated imagery (owner requirement, 29 October 2026)

- New videos use the **immersive** layout by default: the picture fills the whole 1080 × 1920 frame. A safe speaker interval is enlarged to the full height with a horizontal crop at the chosen portrait focus, the source's bottom attribution strip is kept at full width at the very bottom, and timed captions overlay the lower band of the picture (top at 1364 px), never the face. Unscreened intervals keep the complete source picture centred in the frame. The **classic** framed layout (picture at y=72–1352, captions below) remains selectable in Settings, and every approved file keeps the layout it was reviewed with.
- New videos use the **narrative** storyboard by default (`narrative-storyboard-v3`): the source reviewer plans a scene for every distinct spoken idea, event, character, place or metaphor, in spoken order, up to 14 scenes of 3–12 seconds, which may follow one another directly and may cover up to 85% of the excerpt. The first 2.5 seconds and the final 6.5 seconds always show the speaker. Every scene is still cited to the exact spoken segments, generated from its own brief, independently reviewed, and dropped in favour of the speaker when it fails review. The **restrained** storyboard (`context-rich-v2`: up to six separated inserts, 40%) remains selectable. When a narrative storyboard covers less than 60% of the excerpt, the source reviewer is asked once more, with the exact uncovered spans, to add scenes without changing the existing ones; spans whose words have no faithful scene stay on the speaker. A per-file re-render prefixes checkpoint keys with the file id, so checkpoint keys may be up to 240 characters.
- Immersive scenes are generated as full-screen 9:16 stills with the focal subject in the upper two thirds, and rendered with a slow alternating camera move (zoom and drift) so the narration imagery reads as footage. Rendered inserts are finite streams placed at their start time; the speaker passes through before and after. In the immersive layout a scene that fails review is simply dropped and the full-screen speaker remains; only the classic layout falls back to the framed picture.
- All generated imagery follows Sanatana Dharma norms (`sanatana-photoreal-v4`): deities in their correct traditional iconography; people depicted as devotees of Bharat with a bottu or tilak and traditional Hindu attire (dhoti or panche with angavastram, kurta, saree, veshti; ochre or white for ascetics with rudraksha or tulasi beads); settings of temples, ashramas, puja rooms, riverbanks, villages and towns of Bharat; no Western or generic stock-photo styling. Countable attributes are fixed for the whole storyboard (`deity-identity-v4`): a recurring deity, serpent or figure keeps the same number of hoods, heads, faces and arms in every scene, every brief states the count, the image reviewer counts them in the pixels, and a mismatch is corrected up to twice before the scene is dropped. Kaliya has exactly seven hoods (one central, three fanned on each side) unless the passage says otherwise. The rules on sacred iconography and the ban on fabricated guru likenesses are unchanged. Changing this policy invalidates earlier image caches by design.

## Scene image delivery and the learning loop (owner requirements, 29 October 2026)

- **Image delivery** is an Admin setting (Settings → Visual settings). **Batch** (the default; an installation whose worker and web run with `STUDIO_IMAGERY_DEFAULT=immediate`, such as DP, defaults to Immediate until an Admin chooses) sends every scene of a file to the provider's batch queue at half the image price; the generation job parks itself (`STUDIO_IMAGE_BATCH_PENDING`, no retry attempt consumed) and checks every ten minutes until the images arrive, reviews each one in real time exactly as before, sends only the rejected scenes to a correction batch, and gives up on a scene after three rounds. A file therefore finishes on its own after a few hours and at most a day per round; up to 80 of the workspace's jobs run at the provider at once. **Immediate** draws each scene right away at full price. Batch images carry no previous-scene reference; consistency rests on the fixed appearance line and the counting reviewer.
- **The Studio learns from its own rejections.** Every failed image review, and every curator rejection comment, is distilled by the drafting model into one general rule (iconography, anatomy, composition, style, continuity or lettering), stored in `studio_visual_lesson`, and applied to every later brief, image generation and review in this workspace; identical rules count hits instead of duplicating. Admins see every rule with its source and hit count on the Settings page and can retire a wrong one. Learning is best effort and never fails a generation. Rules are part of the screening and image fingerprints, so new rules apply to new work only; approved files are unchanged. This is what turns a one-off defect such as a phone frame around a scene or a head on a serpent's tail into a standing rule without a code change.

## Supporting images

- Accuracy starts with the initial art brief, before image generation. Specify the central subject and form from the cited passage, the precise meaning/action, visible identifying attributes, scenic setting/light/palette, safe placement, and concrete identities or irrelevant objects to exclude. Do not send a generic request for a beautiful goddess and rely on review to establish identity. A deity mentioned only in comparison must not replace the central subject.
- Never interchange Durga, Lakshmi, Saraswati or other forms of Devi, or invent a hybrid. For an unspecified general Durga illustration, explicitly compose a gentle Durga with eight distinct arms and a visible lion/tiger, trident and coherent protective attributes; keep these inside the uncovered artwork area. This is a chosen clear visual convention, not a claim that all traditional forms are identical. A particular named form must follow its supported iconography and arm count. Photographic treatment must preserve this sacred anatomy; do not simplify the general Durga composition into an ordinary two-armed figure. A lotus, clothing color or caption alone cannot establish identity. The independent image check must describe the visible evidence and fail a wrong or uncertain identity even when all aesthetic checks pass. References informing the general visual convention: [The Met, Durga](https://www.metmuseum.org/art/collection/search/719420) and [British Museum, Lakshmi](https://www.britishmuseum.org/collection/object/A_2016-3059-1). These references establish distinctions; their images are not downloaded or reused.
- A curator-requested hold can extend an existing image up to eight seconds, within its cited spoken passage and a 30% total insert budget. Preserve the exact reviewed image and unrelated timing. Recheck the rendered context; do not generate a different image for a timing-only correction. Legacy storyboards remain readable; new storyboards use the versioned contextual policy below.
- Preserve continuous source audio. Use a relevant image only when it clarifies the exact spoken passage. Return to the speaker, keep the first five seconds and final 6.5 seconds free of inserts, and avoid gratuitous visual changes.
- Prefer nature and scenic settings—rivers, forests, mountains, gardens, lotus ponds and gentle natural light—when they express the spoken meaning. Do not substitute unrelated scenery for a required narrative detail. Avoid unnecessary stock people or objects.
- Generate a new sacred, serene, elegant illustration from the exact cited native passage and its meaning. A broad topic match is insufficient: generic scripture books, holding hands, praying people or unrelated scenery do not qualify. Independently review the actual image against the passage and require an explanation of the specific visual relationship. Allow one targeted correction using the actual rejected image and its review findings; remove invented lettering without turning the artwork into a poster or labeled layout; unresolved findings hold an illustrated post, while an optional video insert falls back to the original footage before final audiovisual review. These are conceptual devotional visualizations, not actual places, events or guru photographs. Use photorealistic natural lighting, textures, materials and coherent anatomy; avoid painterly, cartoon or plastic CGI styling. Every new image requires a dedicated photorealism verdict based on visible texture/light evidence, independently of its beauty or religious relevance. Express metaphors through realistic settings and composition instead of neon diagrams or holographic architecture. Do not burn AI-generated labels, generator badges or watermarks into artwork, videos or posts. Keep source hashes, generation model, prompts and review history internally. This versioned art direction applies even to older saved visual preferences; refreshing images invalidates previous style caches.
- Books and manuscripts are permitted when directly relevant to reading, scripture or study. They are not categorically banned. Use unlettered covers/pages in generated artwork; do not invent verses or pseudo-script. Inspect the complete artwork and four detailed quadrant views to catch small lettering and malformed details. Nature is a preference, not a substitute for the passage’s actual subject.
- Every insert has a custom brief, private asset, verified content hash, source-segment references, timing, rationale and image-generation/review model and timestamp. Save the raster before review so retrying a review does not generate another paid image; identical channel edits reuse it. No arbitrary AI-generated URL or filesystem path is fetched. New `context-rich-v2` storyboards allow up to six distinct inserts, each 3–8 seconds and wholly inside the cited words, separated by at least three seconds of source footage, totaling at most 40% of the clip. Choose their number from the actual teaching, not a quota; complex sacred imagery should remain visible long enough to understand. Soft transitions do not alter the source audio.
- Do not fabricate Sri Swamiji or Sri Bala Swamiji photographs. Actual additional portraits and public photographs need a reviewed asset and recorded reuse authorization before use. Publicly visible does not by itself mean licensed for redistribution.
- A final visual review checks relevance, clean artwork without generator badges, names, speaker framing, captions and natural boundaries. If portrait framing fails, retry once with the whole source picture while preserving reviewed supporting artwork. A failed contextual-image finding holds the file; do not silently remove all imagery merely to pass review. Opening-card and timing-only corrections also hold if their reviewed composition cannot be preserved. Show the specific findings.

### Stable openings

Start immediately with suitable speaker footage. When an excerpt starts with an incidental event poster or unstable imagery, preserve every opening word under one steady card using the authorized @sgsswamiji portrait and the reviewed topic. Fade once into the first screened portrait; never insert a brief full-width video between the card and portrait. Do not substitute later moving lips against earlier audio. Required teaching diagrams or verses must remain visible.

The source reviewer recommends the card only when appropriate. The pure-domain plan limits the bridge to the first ten seconds, verifies it joins a screened scene, and rejects overlap with supporting illustrations or the closing card. Curators may request the same focused visual repair for a single draft. Final review checks the actual opening and handoff; source boundaries, full audio and caption timing are unchanged. Good speaker openings receive no introduction card.

## Illustrated posts and destination links

- Telegram delivers a 1080 × 1350 PNG: a custom, source-relevant AI illustration plus a readable excerpt from the reviewed channel copy. Generate landscape 3:2 artwork for a dedicated 1080 × 672 image area, fit the complete image without cropping or stretching, and place branding/text outside that area. A subtle blurred background fills any aspect-ratio margin. Never trust generated subject coordinates as protection against an opaque text panel. It must not be a random video frame or a title-only thumbnail.
- Build eligible complete-sentence excerpts deterministically from reviewed copy, each at most 320 Unicode characters. The AI selects a candidate index rather than retyping or rewriting the words. This is an editorial excerpt, not an invented direct quotation. Type the words in the renderer; do not ask the image generator to draw scripture or lettering. Keep the full channel caption available alongside the image.
- Independently review both the generated illustration and the final composed post, checking native-source relevance, exact text, mobile readability, attribution, clean presentation and clipping. Retain source/image/render hashes, models, timestamps and file version. Reject invalid evidence. Any text edit invalidates the old image and its review evidence.
- Admin → Settings → Curation & Publishing stores the website, iOS App Store and Android Google Play URLs. Unconfigured stores fall back to `https://sgsdattasannidhi.org/`. The Hub player supplies a real, keyboard-accessible link on the closing-card label, plus a link below the video. Pixels in an exported MP4 cannot be clickable hyperlinks. Social delivery must use placements actually supported by the destination; never promise that a burned-in label itself is interactive.
- The saved visual preference and these versioned policies apply automatically. Existing Gemini API image generation and independent review are sufficient; additional Codex plugins or consumer subscriptions are not required for the deployed application.

## Improvement, identity and storage

- A package may explicitly select the verified `bala-swamiji` source profile for YouTube Shorts. It identifies Sri Datta Vijayananda Teertha Swamiji and `@gurubhavanaadpt` throughout drafting, review, posting copy and provenance. The original closing template was text-only. The owner's 18 October branding update below supersedes that template for new renders; historical approved files retain their evidence. Existing packages retain their existing source identity and destination. A destination link does not determine who spoke the source recording. Source/profile and destination cannot be changed after outputs exist.
- Supporting illustrations form an ordered, source-cued storyboard. Every image must explain the current actor, action, relationship or metaphor, with correct deity/avatar identity and narrative phase. Reference distinctions include [Vishnu’s attributes](https://searchcollection.asianart.org/objects/11282/the-hindu-deity-vishnu), [Narasimha’s form](https://www.britishmuseum.org/collection/object/A_1940-0713-0-69) and [Varaha’s form](https://www.britishmuseum.org/collection/object/A_1962-1231-0-13-16); a specifically identified tradition or episode takes precedence over a general depiction. No reference artwork is copied. The previous **accepted** generated image is supplied separately as a continuity reference for material treatment, palette and recurring characters. It is not evidence for the next passage and must not transfer an avatar, accessory, age or action into a different episode. An arriving character joins rather than silently replacing an existing participant; retain the established cast unless a source-supported departure or explicit tighter framing explains the omission. Never use a rejected image as the next scene's reference. Repair uses the rejected image only to correct its specific findings.
- The image reviewer separately judges context, iconography, photographic treatment, anatomy/composition, invented lettering and continuity. Different named figures need distinct faces or hair/beard silhouettes; recurring figures retain their established identity. Generate one full-frame scene, never stacked panels or a storyboard sheet. A beautiful image cannot compensate for a failed accuracy check. Store the continuity-policy version and reference-image hash in checkpoint identity. Citation validation rejects intervening uncited speech while allowing natural pauses; adjacent timestamps alone do not establish semantic relevance. Retain the original footage if an optional illustration cannot pass its bounded correction. The complete rendered video still requires its own audiovisual review.
- Store the quality-policy version, source/render hashes, file version, reviewer model/time, scene/insert decisions and automatic repair count with the output. Any editorial change invalidates that evidence.
- Human rejection comments feed the next scoped draft and source-screening pass. New failure classes become explicit policy rules and regression tests. This is an auditable correction loop; it is not autonomous model-weight training or permission for the system to rewrite its own rules.
- Replace existing output identities after successful generation. Do not create a second landscape/portrait set. Internal attempts are private working data, not user-visible file versions.
- A YouTube Short and Facebook Reel may share identical video bytes when the actual audiovisual edit is identical. Keep their separate channel copy, approval and publishing state. The current channel-bound asset contract stores separate named objects; generation reuses a render for identical requested video specifications. Physical cross-channel storage deduplication needs a separate asset/retention migration and is not claimed here.
- Never overwrite human-approved or published media during a batch refresh. Do not remove a last good file until its replacement and references have been verified.
- Preserve completed transcription sections and the same Sarvam job ID during recovery. An explicit rejected start (for example HTTP 429) or proven pre-connection failure restores that job's retryable checkpoint; a timeout, disconnect or server error retains its uncertain-start state and requires status reconciliation. Never create a replacement paid job merely because a response was lost. The 18 October Vishnu Purana run exposed two accepted-but-not-started jobs: the operator recovered those same stale IDs once, with a durable attempt record, while other recordings continued. This operator recovery is not permission for unbounded automatic start retries.

## Verification checklist

1. Automated tests: unsafe crop/transition rejection, caption bounds, context-specific generation, bounded image correction, checkpoint reuse, image hash/source binding/timing, actual-audio boundary failures, bounded render repair, file-hash evidence binding, and selected-file correction isolation.
2. Actual media: decode/probe every replacement; verify dimensions, duration, original audio, English caption files and source/render hashes.
   Test the deployed Linux renderer with clips ending at the source file's EOF. The video stream itself must retain the full caption-free closing hold, independently of the audio/container duration; normalize the filter frame rate before padding.
3. Visual evidence: inspect the opening, each distinct scene/insert, representative captions and the closing. Recheck questionable findings against the original.
4. Workflow: verify the same master/package/output IDs, no duplicate active files, complete playlist overview, curator correction and approver access. Human approval and publication remain explicit actions.


### Consistent speech volume

Every newly rendered spoken Short/Reel measures its own selected source interval, then uses two-pass loudness normalization to −22 LUFS with a −2 dBTP ceiling. This matches the owner-accepted third Truteeya clip rather than inheriting quiet levels from other parts of the livestream. Preserve speech timing, pitch, words and the clean silent closing hold. Measure the final AAC output again: reject results outside ±1 LU of the target or above −1 dBTP. Silence, invalid measurements and unusably faint sources cannot pass as finished videos. The audio policy participates in render cache identity. Existing approved files are not changed automatically.

## Series parity with the Hub (18 October 2026)

The Vishnu Purana run exposed an orchestration gap: real Hub workers generated the
media, but an operator script coordinated independent source links. The product now
accepts up to 100 video links as one named series in Start New Curation. Canonical
source IDs deduplicate originals; the series is an internal collection, never a fake
YouTube playlist. It shares the existing playlist permissions, generation, review,
verification and cleanup paths. Existing packages and approvals are preserved.

Select the Sri Bala Swamiji / Gurubhavana ADPT branding profile for this series.
It selects YouTube Shorts and credits the correct speaker and Gurubhavana source.
Existing packages retain their original Gurubhavana destination metadata. The newer
SriBalaSwamiji closing design requires the actual new channel to be configured before
publication; the source channel must not masquerade as that new destination. English captions remain the default. All complete messages,
source-grounded artwork, translation checks and independent AI review use the same
normal generation pipeline. AI pass does not grant human approval or publication.

Run the standard `ops/studio-configured-providers.ts` bootstrap, which starts
`apps/distribution-worker/src/studio-index.ts` and monitors the sealed provider
configuration. `STUDIO_GENERATION_CONCURRENCY` accepts integers 1–8 (default 1).
`STUDIO_MEDIA_PROCESS_CONCURRENCY` independently limits CPU-heavy FFmpeg/ffprobe
operations to 1–4 (default 1). On the 2-CPU GBADPT host, use two generation
slots and one media slot so provider waits can overlap without simultaneous
full video encoders. Queue waits are bounded to five minutes, abort promptly
on shutdown, and do not consume the executable timeout. Monitor memory,
provider rate limits and output throughput before increasing either setting.
The generation queue and bounded import prefetch scale with that capacity; downloads
remain serialized per provider, and publication retains one loop. Set concurrency to
5 only on a worker with suitable CPU, memory, scratch space and provider quota.
Multiple deployed worker replicas multiply generation concurrency. Never increase
replicas or concurrency to bypass a provider cooldown or verification challenge.

Resume uses existing leases/checkpoints. Explicitly rejected Sarvam starts preserve
the created job ID for safe retry; uncertain paid requests are reconciled rather than
blindly recreated. Curators see individual failure codes and can retry unfinished
members from the bundle. Verification uses the exact selected collection, even when
it is outside the first page of imports. No publication is enabled by these changes.

Local verification: submit the verified 51 recordings through the actual Hub UI,
save shared settings once, resume pre-existing jobs with the standard worker, confirm
all bundle files and per-recording lifecycle columns, and verify approved snapshots
remain unchanged in disposable PostgreSQL tests. The current browser port remains
unchanged at the user's request. Future local web sessions should use the established
3020 entry point rather than add preview ports.


## Exact native-audio boundary audit and green subscription cards (18 October 2026)

The owner identified Day 1, Short 2 ending inside a Telugu phrase. Existing broad
editorial and visual checks had accepted an earlier completed moral and missed a
new unfinished sentence at the end. ASR punctuation and polished English subtitles
were not sufficient evidence. New generation was paused; the frozen local inventory
contained 41 Shorts from 20 recordings. Independent first/last-audio review rejected
four files (Days 1, 6, 13 and 22); the other 37 passed that boundary audit. This count
is an audit finding, not a claim that all corrections or human approvals are complete.

A separate full-content audit found another omitted-setup problem on Day 15. The
follow-up check now supplies two excluded neighboring segments explicitly as context
the viewer has **not** heard. This catches a complete sentence whose meaning changes
when the following qualification is omitted, and a concluding verse that requires its
next explanation. It must never import those excluded words into English captions.
Day 1's anger teaching was shortened before a qualified assertion; subsequent checks
also flagged incomplete endings on Days 2, 10 and 14 and another opening on Day 13.
These findings are tracked per exact output/hash; no failed model verdict is overwritten
as a pass. Curator-selected shorter passages still undergo the same native-audio,
translation, framing and final-render checks.

The normal Hub pipeline now requires two focused native-audio boundary reviews before
spending on artwork/rendering. Each hears only the exact included clip and an isolated
replay of its first or last 30 seconds. Captions, titles and drafting rationales are
excluded. Store the actual native boundary words, meaning, completion verdict,
missing-context and clipped-syllable findings, and exact source range. Uncertainty or
any failed edge overrides a broad positive verdict and enters the existing bounded,
selected-message repair loop. New policy fingerprints invalidate older cached passes.
The same reviewer audits the bytes of already rendered outputs. Retain source/output
IDs and history; never regenerate unaffected teachings merely because one fails.

Owner branding ruling: all newly rendered closing cards are green (`forest`), show
Sri Datta Vijayananda Teertha Swamiji's authentic portrait and the respective channel
name, and use “Tap Subscribe”. SriSwamiji uses “Stay connected with Pujya Sri Swamiji”
and “🙏 Subscribe to this channel for His teachings, divine music, and blessings.”
SriBalaSwamiji uses “Stay connected with Pujya Sri Bala Swamiji” and “🙏 Subscribe to
this channel for His teachings, discourses, and spiritual guidance.” The card lasts
five seconds: the final two seconds of uninterrupted speech followed by the existing
three-second silent, caption-free hold. Never cut or stretch speech to create the card.
The MP4 graphic is not clickable; viewers use YouTube's own Subscribe button.

Portrait asset: `apps/distribution-worker/assets/sri-bala-swamiji-portrait.jpg`, the
unaltered [Gurubhavana ADPT channel](https://www.youtube.com/@gurubhavanaadpt) avatar,
retrieved 18 October 2026. The [official biography](https://www.dattapeetham.org/page/view/sri-bala-swamiji)
links this source channel. The portrait is also a provisional channel mark; replace
it with the destination channel's approved logo when available. No AI likeness is used.
The owner has the [AvadhootaDattaPeetham account](https://www.youtube.com/@AvadhootaDattaPeetham)
but has not yet created SriSwamiji/SriBalaSwamiji. Do not invent their URLs or connect
publishing to the parent URL as if it were either new channel. Existing source links
remain source provenance; connect the actual publishing channels only after creation.
The player must not link a SriBalaSwamiji card to the old Gurubhavana URL or parent
account. It shows the intended name and pending destination instead. Server-side
publication refuses an unresolved new card destination; human review and approved-file
export remain available. Existing subscription descriptions also need their actual
destination updated before publishing. Historical closing-card policies keep their
existing links and approval evidence.

Local UI verification exposed a separate preview-dialog lifecycle bug: React Strict
Mode's cleanup queued a native close event after the dialog reopened, immediately
dismissing a filename preview. Ignore that stale event while the dialog is open and
avoid restoring outside focus during the reopened modal. Test both the replayed event
and normal closing; verify actual filename activation, Escape and focus return in the
Hub browser.


### Local verification outcome (18 October 2026, 20:20 IST)

All 41 frozen existing Shorts from 20 recordings were replaced under the same output
IDs and independently audited after rendering: 41 passed, zero failed, zero errors,
zero pending in that existing-file audit. Every file decodes, is 1080 × 1920, stays
within the three-minute limit including the closing hold, carries English caption
files and original audio, and has the five-second green card. The exact current file
hashes agree across the encoded-media audit, native-boundary/content review, sampled
opening/midpoint/closing contact frames and review-gallery manifest. AI passes and
technical frame inspection are not the owner's human publication approval.

The last Day 14 correction restores segment 206's Guru setup and ends after segment
208's complete lamp/practice teaching; it does not borrow that setup through English
subtitles. Day 2 now ends after segment 88, before the new Vedic-definition discussion.
The native-audio reviewer receives cancellation, and its checkpoint identity includes
the actual included and excluded transcript context as well as the source hash/range.
An unchanged failed boundary stays failed on retry; corrected source context requires
fresh review.

`pnpm check` passed all guardrails, lint, TypeScript/native type checks and 4,666 tests
in 552 files (72 files / 599 tests intentionally skipped by the ordinary suite).
Separate local PostgreSQL publication-guard and focused UI/domain checks passed 73
tests. Actual Hub filename preview, Escape and return focus were exercised in the
browser. This was a local Hub change; no deployment, mobile binary release, human
approval or social publication was performed.

Evidence lives in the local content run `content-runs/2026-10-18-gurubhavana-vishnu-purana`:
`final-review/summary.json`, `replacement-review/report.json`,
`replacement-review/visual-checks.json`, and `finished-shorts/manifest.json`.
The gallery contains exactly 41 links to the current media, with no extra MP4 copies.
The full source collection remains 51 recordings covering 47 verified days; the other
31 recordings remain paused at their existing import/generation states. They are not
claimed complete. New channel URLs, approved logos and subscription descriptions still
need final destination setup before publication.


### Minimal green card and resumed series (18 October 2026)

The owner corrected the displayed name to **Sri Datta Vijayananda Teertha Swamiji**.
The v4 closing card retains the authentic portrait and forest-green background,
but displays only the formal channel name and “Tap Subscribe.” The portrait is the
provisional channel mark; duplicated invitations and button-explanation paragraphs
are removed. Keep the final five-second timing and caption-free silent hold. Existing
v3 evidence remains readable and does not acquire an invented publishing destination.

The owner authorized resuming the remaining 31 recordings locally. New outputs use
English captions, the normal source-grounded artwork pipeline, and all native-boundary,
content, image and final-render review gates. Everything remains unapproved. Existing
41 outputs receive scoped closing-only revisions under the same IDs; any concrete
new review failure is corrected only on its affected output and must pass again.

A local core authority timeout during concurrent testing interrupted several renders.
The worker must stop when fresh permission cannot be checked, but known-safe work
can defer the same durable job for a bounded retry. A new claim rechecks permission.
A denied renewal, lost lease, ambiguous transcription creation or AI quality failure
must never be converted to that transient retry. No permission caching or bypass is
introduced. YouTube requested interactive verification for pending source downloads;
that remains a human step, separate from the already-downloaded generation jobs.
