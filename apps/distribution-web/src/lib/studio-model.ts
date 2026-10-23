import type {
  PostingCheck,
  StudioAsset,
  StudioOutput,
  StudioPackage,
  StudioPublication,
  StudioReadiness,
} from "@satsang/distribution-domain";
import { studioNeedsSuitabilityReview } from "@satsang/distribution-domain";

/** The operator client receives a filename and authenticated URL, never a storage address. */
export type PublicStudioAsset = Omit<StudioAsset, "storageKey">;
export type PublicStudioOutput = Omit<StudioOutput, "asset" | "captions" | "thumbnail"> & {
  asset: PublicStudioAsset | null;
  thumbnail?: PublicStudioAsset;
  captions: { language: StudioOutput["language"]; asset: PublicStudioAsset; translated: boolean }[];
};
export type PublicStudioPackage = Omit<StudioPackage, "outputs"> & {
  outputs: PublicStudioOutput[];
};
export type PublicStudioPublication = Omit<StudioPublication, "accountId"> & {
  selectedAccountId?: string | null;
};
export type StudioDetail = {
  package: PublicStudioPackage;
  publications: PublicStudioPublication[];
  readiness: StudioReadiness;
  blockers: string[];
};
export type StudioListing = {
  packages: PublicStudioPackage[];
  /** Posting receipts are fetched together for the visible workspace, never per file. */
  publications?: PublicStudioPublication[];
  readiness: StudioReadiness;
};
export type StudioPlaylistPostingCheck = {
  playlistId: string;
  accountId: string;
  checkedAt: string;
  /** Ignore check results if the current package revision differs. */
  revisions: Record<string, number>;
  checks: Record<string, PostingCheck>;
};

export const STUDIO_STATUS_LABELS: Record<StudioPackage["status"], string> = {
  QUEUED: "Queued for generation",
  GENERATING: "Generating content",
  DRAFT: "Awaiting Curator submission",
  IN_REVIEW: "Awaiting Content Approver review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved",
  DISCARDED: "Discarded",
  FAILED: "Generation needs attention",
};
export function studioStatusLabel(pkg: Pick<StudioPackage, "status" | "failure">): string {
  return pkg.status === "FAILED" && studioNeedsSuitabilityReview(pkg.failure)
    ? "No suitable excerpt found"
    : STUDIO_STATUS_LABELS[pkg.status];
}
export const STUDIO_PUBLICATION_LABELS: Record<StudioPublication["status"], string> = {
  QUEUED: "Queued",
  RUNNING: "Sending",
  PROCESSING: "Channel is processing",
  PUBLISHED: "Published",
  SIMULATED: "Test completed — not posted",
  BLOCKED: "Connection or approval required",
  FAILED: "Could not publish",
  UNCERTAIN: "Check channel before retrying",
  CANCELLED: "Cancelled",
};

const messages: Record<string, string> = {
  INVALID_STUDIO_OUTPUT_SELECTION:
    "The selected files have changed. Refresh and select the files again.",
  INVALID_STUDIO_PUBLICATION_SELECTION:
    "The selected posting records are no longer available. Refresh and try again.",
  STUDIO_PUBLICATION_RETRACTED:
    "Retracted from Studio. The local file and approval history are retained.",
  STUDIO_ALREADY_POSTED:
    "This file or excerpt is already posted to the selected channel. It will not be sent again.",
  STUDIO_ALREADY_QUEUED:
    "This file or excerpt already has a publishing request for this channel. Wait for its result; it will not be sent twice.",
  STUDIO_POSSIBLE_DUPLICATE:
    "A matching title or description, or an uncertain earlier send, needs review. Compare the existing video in Posting history before posting. Nothing new was sent.",
  STUDIO_POSTING_CHECK_UNAVAILABLE:
    "The channel's posting history could not be checked. Nothing was sent. Check the Buffer connection and try again.",
  STUDIO_POSTING_CHECK_INCOMPLETE:
    "The channel history could not be read completely. Nothing was sent. Retry the check before publishing.",
  STUDIO_POSTING_CHECK_STALE:
    "The channel check expired before sending. Refresh and try again; nothing was posted.",

  STUDIO_ACTION_UNCONFIRMED:
    "The Hub could not confirm this action. It may already have been saved. Refresh the package and check its current status before retrying. Existing sources, drafts and approvals are retained.",
  STUDIO_CLOSING_CHANNEL_REQUIRED:
    "The closing card names a new channel whose destination is not configured. Connect that channel and update its subscription description before publishing.",
  ACCOUNT_NOT_FOUND: "This saved account is no longer available. Refresh and choose an account.",
  ACCOUNT_DESTINATION_IMMUTABLE:
    "Add a new account for a different channel ID. Existing publishing requests must keep their original destination.",
  ACCOUNT_ALREADY_CONFIGURED: "This channel is already saved. Edit its existing connection.",
  SELECT_REPLACEMENT_DEFAULT: "Choose another default account before disconnecting this one.",
  STUDIO_PUBLISH_ACCOUNT_INVALID:
    "The selected account is unavailable or belongs to a different channel. Refresh and choose again.",
  STUDIO_PUBLISH_ACCOUNT_CHANGED:
    "This package already has publishing requests for another account. Its destination cannot be changed after queuing.",
  STUDIO_PUBLISH_ACCOUNT_REQUIRED:
    "Choose a configured publishing account for every included channel.",
  PUBLISHING_ACCOUNT_CHANGED:
    "The account chosen for this publishing request is no longer available. Ask an administrator to restore its connection; the request will not switch to another account.",
  PUBLISHING_DISABLED: "Live publishing is turned off for this environment.",
  TEST_PUBLICATION_NO_EXTERNAL_SEND: "Test completed. Nothing was posted to a social channel.",
  STUDIO_SELECT_OUTPUTS: "Select the file or files that need correction.",
  STUDIO_TARGET_SETTINGS_CHANGED:
    "Keep existing channel, language and caption settings when correcting selected files.",
  STUDIO_CORRECTIONS_PENDING: "Finish the requested file corrections before resubmitting.",
  INVALID_STUDIO_MEDIA_EDITS:
    "Check picture framing, subtitle size and audio settings for this file. Choose one of the listed options and save again.",
  INVALID_STUDIO_TRIM:
    "Choose a start and end inside the selected video, keeping at least one second. Preview the cut before saving.",
  INVALID_STUDIO_CAPTIONS: "Each subtitle must match its source passage and original timing.",
  STUDIO_UNRELATED_OUTPUT_CHANGED:
    "The correction tried to change an unselected file. No results were applied.",
  STUDIO_CLIP_TOO_LONG:
    "A video exceeds its channel limit: Facebook Reels allow 90 seconds; other video outputs allow 180 seconds. Regenerate only the affected file with a shorter, complete passage before review or publishing.",
  GENERATION_REQUIRED: "Generate the package before submitting it for review.",
  NO_INCLUDED_OUTPUTS: "Include at least one output before requesting approval.",
  ASSETS_REQUIRE_REGENERATION:
    "The copy changed. Render the edited file so its downloadable media matches the reviewed text.",
  MEDIA_REQUIRES_REGENERATION:
    "Use Regenerate with guidance to change video, image or caption wording.",
  INVALID_STUDIO_TRANSITION:
    "This action is not available in the package's current state. Refresh and review its status.",
  INVALID_STUDIO_COMMENT: "Keep your review comment within 4,000 characters.",
  INVALID_STUDIO_COPY:
    "Keep the SGS Datta Sannidhi signature and each title and post within its channel limit.",
  TEACHING_INTEGRITY_CONFIRMATION_REQUIRED:
    "Check source boundaries, context, attribution, captions, translations and Ashrama branding, then confirm the review checkbox.",
  MACHINE_TRANSCRIPT_CONFIRMATION_REQUIRED:
    "Check the machine transcript against the recording, then confirm the transcript checkbox.",
  NATIVE_REVIEWER_REQUIRED:
    "A Content Approver qualified for this source language must review this package.",
  STUDIO_NOT_APPROVED:
    "A Content Approver must approve the current package before publication or download.",
  STUDIO_DISCARDED:
    "This package was discarded. Generate a new package from the master to continue.",
  STUDIO_GENERATION_DISABLED:
    "Generation is disabled. An Admin must enable the content generation worker.",
  STUDIO_GENERATION_NOT_CONFIGURED:
    "An Admin must configure the content generation worker before it can process this package.",
  GENERATION_NOT_CONFIGURED:
    "An Admin must configure the content generation worker before it can process this package.",
  GENERATION_TIMEOUT:
    "Generation exceeded its time limit. Retry the package or ask an Admin to check the source duration and worker.",
  SOURCE_INTEGRITY_FAILED:
    "The stored source did not match its recorded checksum. An Admin must verify the master before generation can continue.",
  STUDIO_INTELLIGENCE_NOT_CONFIGURED:
    "The selected content drafting service is not configured. An Admin must check the generation service.",
  STUDIO_TRANSCRIPT_REQUIRED:
    "Save an approved transcript in Editorial review or configure transcription, then regenerate this package.",
  TRANSCRIPTION_NOT_CONFIGURED:
    "Save and approve a source transcript in Editorial review, or ask an Admin to configure automatic transcription, then regenerate this package.",
  BRAND_NOT_CONFIGURED:
    "An Admin must configure the approved Ashrama logo before generating branded media.",
  STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED:
    "This workspace has not authorized external content processing. Use local generation or ask an Admin to review the provider configuration.",
  STUDIO_TRANSCRIPTION_NOT_CONFIGURED_OR_TOO_LARGE:
    "Automatic transcription needs configuration or a smaller source. An approved transcript can also be saved in Editorial review.",
  STUDIO_TRANSLATION_PROVIDER_REQUIRED:
    "Translation is not configured. Select only the source language or ask an Admin to configure translation.",
  STUDIO_PROVIDER_OUTPUT_LIMIT:
    "The AI response reached its output limit. Completed work is saved. An Admin must check this drafting group before retrying.",
  STUDIO_PROVIDER_INCOMPLETE:
    "The AI stopped before completing this drafting group. Completed work is saved; retry resumes unfinished work.",
  STUDIO_PROVIDER_CONTENT_BLOCKED:
    "The AI service blocked this request under its content policy. An Admin must review the source and provider response classification; automatic retries have stopped.",
  STUDIO_PROVIDER_RECITATION_BLOCKED:
    "The AI service stopped this response because of its recitation policy. An Admin must review the affected source passage before retrying.",
  STUDIO_PROVIDER_QUOTA_EXHAUSTED:
    "The AI account has exhausted its quota or credits. An Admin must check the provider dashboard, billing and daily limits. Completed work is saved.",
  STUDIO_PROVIDER_BILLING_REQUIRED:
    "The AI service requires billing or credits. An Admin must check the provider account before retrying.",
  STUDIO_PROVIDER_REQUEST_INVALID:
    "The AI service rejected the model or request configuration. An Admin must check the configured model and supported parameters.",
  STUDIO_TRANSCRIPTION_START_UNCERTAIN:
    "The transcription job was saved, but its start could not be confirmed. An Admin must check its status before retrying; no replacement paid job was created.",
  STUDIO_VIDEO_REVIEW_REQUIRED:
    "Content still needs a complete excerpt or faithful translation after automatic corrections. The package is held from human review. Check the specific findings below, add guidance and retry the affected files; existing files and review history are retained.",
  STUDIO_EDITED_OUTPUT_OMITTED:
    "The AI correction did not return every selected file with its original identity. No partial correction was applied. Existing files are retained; retry the affected files to resume correction.",
  DUPLICATE_STUDIO_PASSAGE:
    "The AI selected the same passage for two different messages. Existing files are retained. Retry the affected recording to find distinct complete messages.",
  STUDIO_MESSAGE_SOURCE_MISMATCH:
    "The AI selected different source passages for channel versions of the same message. Existing files are retained. Retry the affected recording to correct the mismatch.",
  INVALID_STUDIO_MESSAGE:
    "The AI returned an invalid message identifier. Existing files are retained. Retry the affected recording to restore consistent file identities.",
  STUDIO_PRESENTATION_NOT_CONFIGURED:
    "Video screening needs the configured Gemini visual reviewer. Ask an Admin to check Curation & Publishing services.",
  STUDIO_OPENING_CARD_INVALID:
    "The opening card could not join safely to the reviewed footage. Review the opening before trying again.",
  STUDIO_CLOSING_CARD_INVALID:
    "The closing-card timing is invalid. Your existing video is retained; regenerate the affected file to rebuild its ending.",
  STUDIO_PRESENTATION_REVIEW_INVALID:
    "The visual reviewer returned incomplete or invalid evidence. The affected file is held; retry to resume screening.",
  STUDIO_PRESENTATION_BOUNDARY_REQUIRED:
    "The actual video or audio cut still starts or ends abruptly. The affected file is held. Use AI correction to select a complete passage with a natural pause; see the reviewer’s findings below.",
  STUDIO_PRESENTATION_REPAIR_REQUIRED:
    "Framing, subtitles or supporting imagery did not pass the final video check after a safe re-render. The affected file is held; see the specific findings below.",
  STUDIO_IMAGE_NOT_CONFIGURED:
    "Contextual image generation needs a valid configured Gemini image model.",
  STUDIO_IMAGE_GENERATION_INVALID:
    "The image service did not return a usable illustration. Your source and current drafts are retained.",
  STUDIO_IMAGE_REVIEW_INVALID:
    "The illustration review could not be completed. The image has not been accepted.",
  STUDIO_IMAGE_REVIEW_REQUIRED:
    "A custom illustration did not pass source relevance or visual quality checks after correction. The current draft is retained.",
  STUDIO_POST_ART_INVALID:
    "The illustrated post has incomplete source or image evidence. The existing file is retained; retry this file to rebuild it.",
  STUDIO_POST_EXCERPT_INVALID:
    "The image excerpt must contain complete sentences taken from the reviewed post text. This file is held for correction.",
  STUDIO_POST_LAYOUT_INVALID:
    "The title or excerpt will not fit legibly on the image. Shorten the post copy or request AI correction; no text has been cut off.",
  STUDIO_POST_ART_REVIEW_REQUIRED:
    "The illustrated post did not pass its final image and text review. The existing file is retained; see the findings below.",
  STUDIO_ILLUSTRATION_INVALID:
    "A supporting image or its source-linked timing could not be verified. The affected file is held for correction.",
  STUDIO_DISCOVERY_REVIEW_INVALID:
    "The AI duplicate check returned an incomplete result. Existing files and completed sections are saved. Retry to resume safely.",
  STUDIO_DISCOVERY_ISOLATION_REQUIRED:
    "Discovery tried to change an existing file, so the update was stopped. Your existing files are unchanged.",
  INVALID_STUDIO_DISCOVERY_COVERAGE:
    "Section coverage could not be verified. Existing files are retained; discovery must complete before new files are accepted.",
  STUDIO_VIDEO_REVIEW_INVALID:
    "The content quality reviewer returned incomplete checks. No unchecked content has been rendered. Retry to resume from the saved drafting stage.",
  STUDIO_NO_SUITABLE_CHANNELS:
    "The AI found no complete excerpt suitable for the requested content. No file was created or approved. Check whether this is an introduction, musical prelude or incomplete recording; use the full discourse where available. Retry only after changing the source or guidance.",
  STUDIO_PROVIDER_RATE_LIMITED:
    "The AI service reached its rate limit. Completed work is saved. Retry after the provider cooldown or ask an Admin to check the account limits.",
  STUDIO_PROVIDER_AUTHENTICATION_FAILED:
    "The configured AI service rejected its credentials. An Admin must check the saved provider connection.",
  STUDIO_PROVIDER_TIMEOUT:
    "The AI service exceeded its response time limit. Completed work is saved; the affected stage is shown above.",
  STUDIO_PROVIDER_ABORTED:
    "Processing was interrupted. Completed work is saved. A scheduled retry resumes it automatically; otherwise use Retry to continue.",
  STUDIO_TRANSCRIPTION_PROVIDER_UNSUPPORTED:
    "The selected transcription service is not supported. An Admin must correct the worker configuration.",
  STUDIO_TRANSCRIPT_INVALID:
    "Transcription returned incomplete text or invalid timestamps, so content generation stopped before drafting. Your master is saved. Retry to recheck the saved transcription; if it still fails, ask an Admin to inspect the transcription result.",
  STUDIO_TRANSCRIPT_LANGUAGE_MISMATCH:
    "The transcription language does not match this master's source language. Check the source language before retrying.",
  STUDIO_PROVIDER_TRANSCRIPTION_FAILED:
    "The speech service could not transcribe the recording. Your master is saved; retry transcription after checking the original audio and service readiness.",
  STUDIO_TRANSCRIPTION_CONTEXT_LIMIT:
    "The speech service could not process an audio section within its capacity. Your master and completed sections are saved. Retry to resume automatic processing in smaller sections; no manual file splitting is needed.",
  STUDIO_SARVAM_CONFIGURATION_INVALID:
    "The transcription model or devotional vocabulary needs correction in the worker configuration.",
  STUDIO_AUDIO_INVALID_OR_TOO_LARGE:
    "An audio analysis section could not be prepared. Your master is saved. Retry to resume automatic processing; long recordings do not need to be split manually.",
  STUDIO_AUDIO_MEASUREMENT_FAILED:
    "The audio level could not be measured. This file has been held; retry rendering to run the audio checks again.",
  STUDIO_AUDIO_UNUSABLE:
    "This excerpt's audio is silent or too faint to normalize reliably. Check the original recording and choose an audible passage.",
  STUDIO_AUDIO_QUALITY_FAILED:
    "The rendered audio did not meet the speech-volume or clipping checks. This file has been held for correction; your existing files are retained.",
  STUDIO_PROVIDER_UNAVAILABLE:
    "The AI service is temporarily unavailable. Your source, review history and completed generation work are saved. Retry resumes unfinished work.",
  STUDIO_CLOSING_PRESERVATION_FAILED:
    "The closing-card update did not preserve the existing audio, picture or subtitles closely enough. Your saved Short is unchanged. Ask an administrator to inspect the preservation check before retrying.",
  STUDIO_CLOSING_TIMELINE_CHANGED:
    "This saved Short uses a different ending duration. A card-only update cannot change its timeline. Open the editor to review a full render; your existing file and edits are retained.",
  STUDIO_GENERATION_FAILED:
    "Generation could not finish. Check service readiness and regenerate the package.",
  GENERATION_FAILED:
    "An unexpected error stopped this recording at the stage shown above. The source and saved work are retained. Retry the unfinished recording; if it fails again, ask an administrator to check the worker logs. Other recordings can continue.",
  STUDIO_PUBLICATION_FAILED:
    "Publication could not finish. Check the channel result before retrying.",
  CHANNEL_NOT_CONNECTED: "An Admin must connect the Ashrama's verified account for this channel.",
  TEST_NETWORK_DISABLED: "This test workspace never posts to external channels.",
  STUDIO_PROVIDER_CONFIG_INVALID:
    "Channel configuration needs an Admin's attention before publication.",
  WHATSAPP_RECIPIENT_DELIVERY_NOT_CONFIGURED:
    "WhatsApp drafts are available. Automatic delivery requires an opted-in recipient workflow, approved templates and delivery-receipt handling; it is not enabled yet.",
  YOUTUBE_PUBLISH_SETTINGS_REQUIRED:
    "The YouTube account needs explicit publication and audience settings.",
  TIKTOK_AUTOMATIC_ELIGIBILITY_REQUIRED:
    "Automatic TikTok publication requires verified account eligibility.",
  PINTEREST_BOARD_REQUIRED: "Choose an authorized Pinterest board in the channel configuration.",
  REDDIT_DESTINATION_REQUIRED:
    "Configure and verify the intended Reddit community before publication.",
  TELEGRAM_CHANNEL_REQUIRED: "Configure the authorized Telegram channel before publication.",
  STUDIO_BLOG_PUBLICATION_NOT_CONFIGURED:
    "The Ashrama blog publishing address has not been configured.",
  STUDIO_PUBLISHING_DISABLED:
    "Live publication is disabled. An Admin must enable the publishing service after channel setup.",
  STUDIO_PUBLIC_MEDIA_NOT_CONFIGURED:
    "Secure media delivery needs configuration before this channel can receive videos or images.",
  CHANNEL_DISABLED: "This channel connection is disabled.",
  ACCOUNT_ELIGIBILITY_REQUIRED: "An Admin must verify this account's publishing eligibility.",
  INVALID_ACCOUNT: "The channel account configuration is incomplete.",
  UNSUPPORTED_TRANSPORT:
    "This account's publishing connection does not support the selected channel.",
  TERRITORY_NOT_PERMITTED:
    "The source rights do not permit worldwide channel distribution. Confirm the permitted territories with the rights holder.",
  REVIEWER_ROLE_REVOKED:
    "The Content Approver's role changed. The package needs a current authorized review.",
  REQUESTER_ROLE_REVOKED: "A package contributor no longer has the required Content Curator role.",
  PUBLISHER_ROLE_REVOKED: "The Content Approver no longer has permission to publish.",
  FORBIDDEN: "Your current role cannot perform this action.",
  INDEPENDENT_REVIEW_REQUIRED:
    "A different Content Approver must review a package you contributed to.",
  REVISION_CONFLICT: "This package changed. It has been refreshed; review the latest version.",
  SOURCE_VERSION_STALE:
    "The master recording changed. Generate a new package from the current master.",
  SOURCE_DEPENDENCY_CHANGED: "The source changed. Open the master and generate a current package.",
  SOURCE_MISMATCH: "The source changed. Open the master and generate a current package.",
  CONTENT_WITHDRAWN: "This master has been withdrawn.",
  WITHDRAWN: "This master has been withdrawn.",
  NOT_APPROVED:
    "A Content Approver must approve the master source before this package can be approved.",
  APPROVAL_STALE: "The master approval is out of date. Open the source for a new review.",
  OPERATOR_AUTHORITY_UNAVAILABLE:
    "Generation cannot verify your permissions because the core service is unavailable. Retry after the service is restored.",
  UNAVAILABLE:
    "The Hub service is temporarily unavailable. Your master is saved; refresh and retry after the service is restored.",
  unavailable:
    "The Hub service is temporarily unavailable. Your master is saved; refresh and retry after the service is restored.",
  RIGHTS_MISSING: "The Content Curator must save the source rights.",
  RIGHTS_EXPIRED: "Source rights have expired. Update the source rights and request a new review.",
  RELEASE_PENDING: "The source release date has not arrived.",
  RESTRICTED_CONTENT: "Source visibility does not allow channel publication.",
  NO_PERMITTED_CHANNELS:
    "Select at least one supported publication channel in this master’s permissions.",
  CHANNEL_NOT_PERMITTED: "The source rights must explicitly allow the intended channel.",
  INVALID_REQUEST: "Check the fields and try again.",
  NOT_FOUND: "This package is not available in the current workspace.",
};

/** Raw provider/database failures never become interface copy. */
export function studioMessage(code: string): string {
  return (
    messages[code] ??
    "This action is unavailable. Refresh the package and check its source and service readiness."
  );
}
