# Episode 249 — real-source content creation receipt

Date: 4 October 2026. Scope: the owner's local test using [the supplied master](https://www.youtube.com/watch?v=fNyMZjjzMZ0), Sampoorna Mahabharata, Episode 249, from the Sri Ganapathy Sachchidananda Swamiji channel. Nothing was published, deployed, pushed or sent to a hosted AI provider.

## Created files

The completed review package is in `outputs/ashrama-episode-249/`, with `index.html` as its entry point. Large files remain Git-ignored. The master and metadata are retained separately in `outputs/ashrama-episode-249-source/`. The portable review archive is `outputs/ashrama-episode-249-review.zip`.

| Artifact | Result |
| --- | --- |
| Shorts / Reels | Three distinct 1080×1920 MP4 clips, H.264 / AAC, 30 fps; 32.4, 17.2 and 58.2 seconds |
| X video | Separate 720×1280 version of the 32.4-second contentment clip |
| Posts | Three designs, each at 1080×1350, 1080×1080 and 1600×900: nine PNG files |
| Blogs | Two articles, each as branded HTML and editable Markdown |
| Platform copy | Five prepared drafts: YouTube, Facebook, Instagram, X and Reddit |
| Evidence | Exact source/brand/transcript hashes; raw ASR, segment-only import, original metadata, editorial decisions, output probes and package checksums |

The machine-readable receipt is [episode-249-content-preview.json](evidence/episode-249-content-preview.json). The output `manifest.json` records each primary artifact; `integrity.json` covers all package files except itself.

## What the test actually exercised

The source was downloaded at 1920×1080 with its original audio. Local MLX Whisper large-v3 supplied a Telugu recognition draft. Codex selected passages and generated labelled English summaries and platform copy using the native draft, shorter reprocessed passages and the channel's English description. The strict content-pack contract, existing recognition normalization and new local rendering CLI then created the actual files. This was an assistant-assisted acceptance run; it is not evidence of an unattended hosted ASR/semantic service or an adopted publishing connector.

The source's YouTube language metadata said `hi`; the Telugu title, source presentation and transcription required `te`. Raw ASR also exposed 13 word spans outside parent segments, floating-point timestamp noise, six replacement-character spans and one empty instantaneous final segment. Strict word-timing import continues to refuse invalid spans. Explicit segment-only review mode retains all 105 nonempty segment texts unchanged, omits word annotations with warnings, and records the six corrupt-text warnings. No native transcription was silently corrected or approved.

The complete original audio and picture remain in each excerpt. We did not burn uncertain ASR text as subtitles. English headings and summaries are editorial prose, not exact quotations or official translations. Dhritarashtra's counsel remains attributed to that character. Duryodhana's later rationalizations about discontent and taking others' wealth were deliberately excluded as standalone promotional quotations because the narrative's qualification would be lost.

## Branding

Each visual format carries the existing Ashrama-labelled emblem (`apps/web/public/brand/logo.jpg`), Avadhoota Datta Peetham, Sri Ganapathy Sachchidananda Swamiji, episode/source identification, restrained maroon/Kamala/cream/gold styling, and a visible TEST PREVIEW label. Original source artwork remains uncropped. The current SGS Datta Sannidhi app logo was not substituted for the Ashrama identity.

The emblem and profile are checksum-bound. Its use here is a proposed social-content identity for review, not a new institutional brand approval. No copyright owner, official translation or human reviewer approval was invented.

## Recommended placement

| Platform | Use from this package |
| --- | --- |
| YouTube | Contentment Short. Add the master through Related Video where enabled. YouTube accepts square/vertical Shorts up to three minutes; Shorts description/comment links are not clickable. [Shorts guidance](https://support.google.com/youtube/answer/15424877?hl=en), [Related Video](https://support.google.com/youtube/answer/14075157?hl=en-GB), [link guidance](https://support.google.com/youtube/answer/13748639?hl=en-419). |
| Facebook | Steadfastness Reel, then a separate contentment image/blog Page post. The current native video rollout uses Reels without the old universal duration/format restriction; account/API behavior must be qualified separately. [Meta announcement](https://about.fb.com/news/2025/06/making-it-easier-create-videos-facebook/). |
| Instagram | Kinship Reel and a three-card 4:5 carousel. Use an eligible profile/Story link for the eventual approved blog. These export dimensions are conservative design targets; official hard caps could not be freshly verified because the help pages were rate-limited. [Official Story-link announcement](https://about.fb.com/ja/news/2021/10/linkaccessstickers/). |
| X | Contentment 720×1280 video plus the prepared concise post. It fits standard accounts' 140-second/512-MB limits. Do not assume Premium Articles eligibility. [Video guidance](https://help.x.com/en/using-x/x-videos), [Articles](https://help.x.com/en/using-x/articles). |
| Reddit | The contextual text discussion, optionally with a landscape card where permitted. Select a community and check its rules, flair and promotion/AI-text policy first. No subreddit has been selected or posted to. [Posting guidance](https://support.reddithelp.com/hc/en-us/articles/360060422572-How-do-I-post-and-comment-on-Reddit), [spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam). |

Blog URLs are not fabricated. Publish reviewed articles to an approved Ashrama destination before adapting the copy to link to them.

## Verification and remaining gate

Focused source/attribution/format/recognition/template/media tests and a real CLI integration test cover source/hash mismatch refusal, exact normalized transcript binding, all five drafts, actual H.264/AAC output dimensions and duration, branding pixels, retained source audio, immutable output directories and output checksums. Real files were inspected in addition to synthetic tests. Native browser keyboard focus, Space playback/pause and continued Tab navigation were checked. Cards and blog layouts were inspected on desktop and phone widths. A crossfade still and mobile footer wrapping found during review were corrected.

**File creation and local technical rendering succeeded. Native editorial quality and production release remain unapproved.** An authorized Telugu reviewer must check wording, source boundaries and the proposed social identity; translations require their own review. This one unreviewed recording does not qualify the V3.2 golden corpus (20 Telugu, five Kannada, five Tamil). Existing production human-review/rights/export gates and default-OFF flags were not changed.

## Reproduction

Run from the repository root, using a new output directory. FFmpeg and Playwright Chromium must be available:

```sh
pnpm exec tsx ops/distribution-content-preview.ts --test-preview \
  outputs/ashrama-episode-249/evidence/content-plan.json \
  outputs/ashrama-episode-249-source/master.mp4 \
  apps/web/public/brand/logo.jpg \
  outputs/ashrama-episode-249/evidence/transcript-raw.json \
  outputs/ashrama-episode-249-source/youtube-metadata.json \
  outputs/ashrama-episode-249-rerun
```

`ops/distribution-local-transcribe.py` supplies an optional local recognition entry point for subsequent sources. Install its documented runtime into an isolated environment. New recognition bytes require a new transcript hash and matching plan; regeneration never silently replaces an existing reviewed package.
