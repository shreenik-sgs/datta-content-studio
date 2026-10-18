# Studio publishing providers

Verified against official provider documentation on 5 October 2026. These adapters have local contract tests with injected HTTP. No live social account was connected or posted to during development.

## Supported routes

<!-- figure:studio-publishing-receipts -->

| Channel | Transport | Appropriate Ashrama content | Account prerequisite |
| --- | --- | --- | --- |
| YouTube | Buffer | Branded Shorts | Connected channel; explicit privacy, audience, AI disclosure and category settings |
| Facebook | Buffer | Reels, image cards, reflections and blog links | Connected Page with automatic publishing rights |
| Instagram | Buffer | Reels and image cards | Eligible professional account connected for automatic publishing |
| X | Buffer | Concise reflections, cards, clips and blog links | Connected account and available publishing entitlement |
| TikTok | Buffer | Branded vertical clips | Connected account explicitly verified for automatic publishing; disclosure settings reviewed |
| Threads | Buffer | Reflections, discussion prompts, cards and clips | Connected account |
| LinkedIn | Buffer | Seva, community initiatives, events and relevant blog links | Connected organization Page or approved account with publishing rights |
| Pinterest | Buffer | Evergreen teaching cards and blog discovery | Connected account and explicitly selected board |
| Bluesky | Buffer | Brief reflections and blog links | Connected account |
| Telegram | Direct Bot API | Channel announcements, image cards and clips | Bot authorized to publish in the configured channel |
| Reddit | Direct OAuth API | Contextual discussion or blog-link posts | Approved API access, `submit`/`read` scopes, descriptive user agent and approved subreddit |
| WhatsApp Business | Setup only; automated recipient delivery not implemented | Branded image and message drafts | Opted-in recipients, approved templates, consent/opt-out handling and delivery webhooks required; credentials alone never enable sending |
| Ashrama website | Internal Studio workflow | Full blogs | Managed separately from these external adapters |

Buffer documents an API key for the account owner's connected channels, with media supplied through reachable URLs. Its API supports automatic immediate publication and later post lookup. Here, a successful creation response is only a checkpoint: publication is confirmed from the automatic post's `sent` status, timestamp and destination URL. A reminder or draft never counts as posted. [Buffer quick start](https://developers.buffer.com/guides/getting-started.html), [supported channels](https://support.buffer.com/en-us/articles/what-is-buffers-api-GtIYIQilz5), [publishing schema](https://developers.buffer.com/reference.html), [video assets](https://developers.buffer.com/examples/create-video-post.html).

TikTok's direct integration rules exclude utilities intended solely for accounts operated by the developer's own team, and require creator-facing consent and publishing controls. Studio therefore uses the documented Buffer route rather than claiming that an internal Direct Post app qualifies. Missing automatic eligibility blocks the channel. There is no download-and-post fallback. [TikTok content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/).

Reddit submission can return application errors inside an HTTP-success response. Studio checks those errors and then retrieves the returned post to verify its subreddit and approved content. Approval of the destination and its community rules remains necessary; the adapter never chooses a subreddit. [Reddit submission API](https://www.reddit.com/dev/api/#POST_api_submit), [API access guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).

Telegram's Bot API returns the sent message. Studio verifies the channel, message ID, text/caption and media type. It does not use updates or repeat a send to infer whether an uncertain request succeeded. [Telegram Bot API](https://core.telegram.org/bots/api).

## Private configuration

`STUDIO_CHANNEL_CONFIG_FILE` is an absolute path to a regular file owned by the worker user, mode `0600`. Symlinks and files over 64 KiB are refused. Configuration is loaded afresh by the caller; secrets must stay outside source control and browser responses. An absent path produces disconnected readiness, without a network call. Invalid configuration throws only `STUDIO_PROVIDER_CONFIG_INVALID`.

Example shape, with illustrative placeholders only:

```json
{
  "version": 1,
  "trustedMediaOrigins": ["https://media.ashrama.example"],
  "accounts": [{
    "id": "ashrama-threads",
    "platform": "threads",
    "transport": "buffer",
    "providerAccountId": "BUFFER_CHANNEL_ID",
    "world": "PRODUCTION",
    "enabled": false,
    "eligibilityVerified": false,
    "accessToken": "CONFIGURE_PRIVATELY"
  }]
}
```

Multiple accounts per channel are accepted, with one explicit `isDefault: true` per platform and a human-readable `label`. Legacy configurations with one account per platform remain valid and use that account as the default. Account IDs are local bindings; `providerAccountId` is a Buffer channel ID, Reddit subreddit name without `r/`, or Telegram `@channel_name`/numeric channel ID. Existing destinations are immutable: add another account to target a different destination. Required defaults:

```json
{
  "youtube": { "privacy": "public", "madeForKids": false, "isAiGenerated": false, "categoryId": "27" },
  "tiktok": { "automaticPostingVerified": false, "isAiGenerated": false },
  "pinterest": { "boardServiceId": "APPROVED_BOARD_ID" },
  "reddit": { "userAgent": "server:sgs-distribution-hub:v1 (by /u/ACCOUNT_OWNER)" }
}
```

These defaults live in each relevant account's `defaults` object. The operator must select truthful values before enabling an account. AI assistance with captions is distinct from synthetic or altered audiovisual media disclosure. Token refresh, Buffer account setup and provider eligibility remain operational prerequisites; configuration readiness is not proof that an expired token currently works.

## Durable worker contract

`createSocialPlatformAdapter` requires an injected `fetcher`, account credentials, trusted media origins and a fresh `authorize` callback. Authorization binds the current Admin-approved payload, account and production world. TEST authorization never makes external HTTP calls. Public channel authorization does not authorize unsolicited direct messages.

Before calling `advance(input, null)`, the caller must durably claim the publication and mark the mutation attempt. There is at most one publishing mutation in that call. Buffer first performs a read-only account check and refreshes authorization. Network failure after dispatch means `UNKNOWN`, including lost responses; never restart creation because no receipt was saved.

Persist every `PROGRESS.checkpoint` atomically before the next step. It contains no credentials or signed media URLs and binds the publication, approval, account, payload checksum, request fingerprint and provider record. Later `advance` calls with a checkpoint and all `reconcile` calls query status; they do not recreate a post. The caller must load checkpoints only from its protected publication record. Missing or uncertain durable state requires reconciliation, not retrying a publish mutation. Provider failure with an existing checkpoint does not authorize creation of another post. The worker retries transport failures and HTTP 429/5xx from receipt reads only, preserving that checkpoint. A transient failure on the twentieth poll stops as uncertain; invalid receipts and authorization failures are never included in these automatic retries.

Approved media URLs must resolve to the immutable checksum-verified bytes and stay reachable until provider ingestion finishes. The adapter enforces HTTPS and exact configured origins; the signing layer owns object identity, expiry and authorization. Provider credentials only go to fixed API hosts, redirects are refused, response bodies are bounded, errors use stable redacted codes, and requests have a 30-second timeout.

## Admin setup

Open **Admin → Settings → Curation & Publishing** (`/distribution/settings`). Only operators granted `operations.manage` can read or change these settings. Curators and Approvers do not gain settings authority merely from those roles. The screen links to the existing AI-provider, branding and feature-switch owners instead of duplicating their secrets or controls. Server generation/publishing flags are displayed as operational prerequisites, not silently changed by saving a token.

For YouTube, connect the intended channel as its owner in [Buffer Channels](https://account.buffer.com/channels), create a key in Buffer Settings → API, and enter it in the Hub's password field. **Find my YouTube channels** performs read-only discovery, then fills the selected channel ID and account name. Save the connection and mark the usual destination as default. Use **Add another account** for additional destinations. Step 6 lets the Approver choose among saved accounts before publication. The choice is saved with the publishing request; later default changes cannot redirect queued posts, and removing a selected account blocks its jobs instead of silently choosing another. Choose a replacement default before disconnecting the current default when other accounts remain.

Provision `STUDIO_CHANNEL_CONFIG_FILE` for production, `STUDIO_CHANNEL_CONFIG_TEST_FILE` for test, and a stable `STUDIO_CHANNEL_CONFIG_KEY` (32 random bytes encoded as 64 hex characters). Initialize each private file with the empty version-1 configuration above and mode 0600. The web and worker must share the same persistent mount, owner and encryption key. Do not use an ephemeral container filesystem. On AWS, provision the encryption key through the deployment secret store; never place it in source control. Back up encrypted settings and preserve the key.

Admin writes encrypt the whole configuration with AES-256-GCM, validate a private temporary file and rename it atomically. Revision checks and an exclusive lock prevent lost updates. Tokens never return in API responses or HTML; blank token fields preserve existing values. Disconnect removes credentials from the active configuration. Test settings never fall back to production. Existing private unencrypted operator configuration remains readable for migration; an Admin save seals it. Saving validates structure, not live token validity.

WhatsApp uses the opted-in-recipient model requested by the owner. Its form captures phone-number ID, Business Account ID, access token, template name/language, Meta app secret and webhook verification token. These are preparatory settings: no webhook endpoint or recipient-consent store is currently implemented, so automatic WhatsApp sending remains blocked even with credentials. Do not register a fictional callback or represent this as WhatsApp Channels/groups support. Meta’s message-template API and delivery-status webhooks must be integrated before this connection can be enabled. Branded WhatsApp post/image drafts can already be generated and reviewed.
