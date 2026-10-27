"use client";

import { DISTRIBUTION_LANGUAGE_NAMES, contentMasterSchema } from "@satsang/distribution-contracts";
import {
  type ContentMaster,
  type DistributionCapability,
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  type StudioGenerationRequest,
  contentDisplayName,
  studioAppDestination,
  studioAppLinks,
  studioCanDiscard,
  studioCanEdit,
  studioCanEditFile,
  studioCaptionsEnabled,
  studioChannelLabel,
  studioClosingChannel,
  studioExternalProcessingDecision,
  studioFileStatus,
  studioNeedsSuitabilityReview,
  studioOutputChannelLabel,
  studioWorkflow,
} from "@satsang/distribution-domain";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  type PublicStudioOutput,
  type PublicStudioPackage,
  STUDIO_PUBLICATION_LABELS,
  type StudioBlockedOperator,
  type StudioDetail,
  type StudioListing,
  studioBlockerMessage,
  studioMessage,
  studioSourceName,
  studioStatusLabel,
} from "../lib/studio-model";

import { useHubTimestamp } from "./hub-locale";
import { PlaylistFiles } from "./playlist-files";
import { PlaylistReviewNavigation } from "./playlist-review-navigation";
import { SeriesNavigation } from "./series-navigation";
import { StorageCleanup } from "./storage-cleanup";
import { StudioCorrectionComparison, StudioCorrections } from "./studio-corrections";
import { StudioGenerationPreviews } from "./studio-generation-previews";
import { StudioGenerationProgressView } from "./studio-generation-progress";
import { StudioHistory } from "./studio-history";
import { StudioLineage } from "./studio-lineage";
import { StudioMediaSummary } from "./studio-media-editor";
import { StudioDraftPostingHistory } from "./studio-posting-check";
import { StudioPreviewDialog } from "./studio-preview-dialog";
import { StudioPreviewLoader } from "./studio-preview-loader";
import { StudioProgressSummary } from "./studio-progress-summary";
import { StudioPublishing } from "./studio-publishing";
import { StudioQualitySelection } from "./studio-quality-selection";
import { StudioSourceRecovery } from "./studio-source-recovery";
import { StudioSourceReview } from "./studio-source-review";
import { StudioWorkflow } from "./studio-workflow";
import { WorkspaceName } from "./workspace-name";

const API = "/distribution/api/studio";
const checkStyle = {
  display: "flex",
  flexDirection: "row" as const,
  alignItems: "start",
  gap: 10,
  minHeight: 44,
};
const boxStyle = { width: 18, minHeight: 18, height: 18, marginTop: 2, flexShrink: 0 };
export function studioGenerationDefaults(
  content?: Pick<ContentMaster, "rights"> | null,
): StudioGenerationRequest {
  return {
    languages: ["en"],
    channels: content?.rights
      ? STUDIO_CHANNELS.filter((channel) => content.rights?.channels.includes(channel))
      : [...STUDIO_CHANNELS],
    instructions: "",
    captions: true,
    allCompleteMessages: true,
  };
}
function generationFields(form: FormData): StudioGenerationRequest {
  return {
    languages: form.getAll("language") as StudioGenerationRequest["languages"],
    channels: (form.has("channel") || form.has("selectChannels")
      ? form.getAll("channel")
      : [...STUDIO_CHANNELS]) as StudioGenerationRequest["channels"],
    instructions: String(form.get("instructions") ?? ""),
    captions: form.get("captions") === "on",
    allCompleteMessages: form.get("allCompleteMessages") === "true",
  };
}
export function GenerationFields({
  request,
  translation,
  localDrafting,
  showChannels = false,
}: {
  request: StudioGenerationRequest;
  translation: boolean;
  localDrafting: boolean;
  showChannels?: boolean;
}) {
  return (
    <>
      <input
        type="hidden"
        name="allCompleteMessages"
        value={String(request.allCompleteMessages ?? false)}
      />
      {showChannels && (
        <fieldset>
          <legend>Channels to generate for</legend>
          <input type="hidden" name="selectChannels" value="true" />
          <p className="muted">
            Choose the destinations you want. Matching media is reused; each channel keeps its own
            posting text and status.
          </p>
          <div className="fields">
            {request.channels.map((channel) => (
              <label key={channel} style={checkStyle}>
                <input
                  name="channel"
                  type="checkbox"
                  value={channel}
                  defaultChecked
                  style={boxStyle}
                />
                {studioChannelLabel(channel)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend>Output languages</legend>
        <p className="muted">
          Choose English for English post text and English subtitles embedded over the video.
          English subtitles are on by default for new packages. Translating a non-English master
          requires the translation service. The original spoken audio stays unchanged. Each selected
          language creates separate outputs.
        </p>
        {!translation && (
          <p className="muted">
            You can select output languages now. Translation must be available before generating
            content in a language different from the master.
          </p>
        )}
        <div className="fields">
          {STUDIO_LANGUAGES.map((language) => (
            <label key={language} style={checkStyle}>
              <input
                type="checkbox"
                name="language"
                value={language}
                defaultChecked={request.languages.includes(language)}
                style={boxStyle}
              />
              {DISTRIBUTION_LANGUAGE_NAMES[language]}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Guidance for this package
        <textarea
          name="instructions"
          rows={3}
          maxLength={4000}
          defaultValue={request.instructions}
          placeholder="Optional: the intended audience, message or changes to make."
        />
      </label>
      <label style={checkStyle}>
        <input type="checkbox" name="captions" defaultChecked={request.captions} style={boxStyle} />
        Embed timed subtitles over videos in each selected output language
      </label>
      <p className="muted">
        The content layer considers the permitted channels and explains which formats are suitable.
        Ashrama branding and source references stay attached to every output.
      </p>
      {localDrafting && (
        <p className="notice" style={{ display: "block" }}>
          Local drafting uses source excerpts. Editorial guidance and translation require configured
          AI drafting; you can edit post and blog copy directly.
        </p>
      )}
    </>
  );
}
export function StudioOutputPreview({
  value,
  output,
  canDownload,
}: { value: PublicStudioPackage; output: PublicStudioOutput; canDownload: boolean }) {
  const formatTimestamp = useHubTimestamp();
  const [closingVisible, setClosingVisible] = useState(false);
  const closing = output.presentationReview?.closingCard;
  const [viewerPlatform, setViewerPlatform] = useState<"ios" | "android" | "web">("web");
  useEffect(() => {
    const ua = navigator.userAgent;
    setViewerPlatform(
      /iPhone|iPad|iPod/u.test(ua) || (/Macintosh/u.test(ua) && navigator.maxTouchPoints > 1)
        ? "ios"
        : /Android/u.test(ua)
          ? "android"
          : "web",
    );
  }, []);
  const subscribe = closing?.destination === "youtube";
  const closingChannel = closing && subscribe ? studioClosingChannel(closing) : undefined;
  const closingLabel = subscribe
    ? `${closingChannel?.name} — watch full videos and subscribe on YouTube`
    : "SGS Datta Sannidhi — download the app";
  const downloadUrl = subscribe
    ? closingChannel?.url
    : closing?.appLinks
      ? studioAppDestination(studioAppLinks(closing.appLinks), viewerPlatform)
      : undefined;
  const media = `${API}/${value.id}/assets/${output.id}`;
  const video = ["short", "reel", "video"].includes(output.format);
  const channel = studioOutputChannelLabel(output);
  const writtenLanguage = DISTRIBUTION_LANGUAGE_NAMES[output.language];
  const sourceLanguage = value.provenance?.transcript.language ?? value.source.language;
  const spokenLanguage =
    DISTRIBUTION_LANGUAGE_NAMES[sourceLanguage as keyof typeof DISTRIBUTION_LANGUAGE_NAMES] ??
    sourceLanguage;
  const embeddedCaption =
    video && studioCaptionsEnabled(output.mediaEdits, value.request.captions)
      ? output.captions.find((caption) => caption.language === output.language)
      : undefined;
  const copyHeading =
    output.format === "blog"
      ? "Blog article"
      : video
        ? `${channel} description`
        : `${channel} post text`;
  return (
    <>
      <StudioProgressSummary packages={[{ ...value, outputs: [output] }]} preview />
      {output.asset?.mimeType === "video/mp4" ? (
        <section aria-labelledby={`media-heading-${output.id}`}>
          <h4 id={`media-heading-${output.id}`}>Video file</h4>
          {output.format === "video" ? (
            <p>Longer story · Download the MP4 for YouTube Studio. Buffer accepts Shorts only.</p>
          ) : null}
          <div className="studio-video-frame">
            {/* biome-ignore lint/a11y/useMediaCaption: Each available source or translated caption is rendered as an optional track below. */}
            <video
              controls
              playsInline
              preload="metadata"
              aria-label={`${channel} ${output.format} preview`}
              src={`${media}/media`}
              poster={output.thumbnail ? `${media}/thumbnail` : undefined}
              onLoadedMetadata={(event) => {
                setClosingVisible(false);
                // Safari may auto-select a language track even without `default`.
                // Suppress that initial duplicate layer; later manual CC choices stay intact.
                if (embeddedCaption)
                  for (const track of event.currentTarget.textTracks) track.mode = "disabled";
              }}
              onTimeUpdate={(event) =>
                setClosingVisible(
                  !!closing &&
                    event.currentTarget.currentTime * 1000 >=
                      closing.startMs + closing.transitionMs,
                )
              }
              onEnded={() => setClosingVisible(!!closing)}
              style={{
                width: "100%",
                height: "100%",
                maxHeight: "none",
                background: "#181118",
                borderRadius: 10,
              }}
            >
              {output.captions.map((caption) => (
                <track
                  key={caption.language}
                  kind="captions"
                  default={!embeddedCaption && caption.language === "en"}
                  src={`${media}/captions?language=${caption.language}`}
                  srcLang={caption.language}
                  label={`${DISTRIBUTION_LANGUAGE_NAMES[caption.language]}${caption.translated ? " (translation)" : " (source)"} — optional CC`}
                />
              ))}
            </video>
            {downloadUrl && closingVisible && (
              <a
                className="studio-card-download"
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={closingLabel}
                title={closingLabel}
              >
                <span className="visually-hidden">{closingLabel}</span>
              </a>
            )}
          </div>
          {downloadUrl && (
            <p>
              {subscribe ? "YouTube channel:" : "App download:"}{" "}
              <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
                {subscribe ? closingChannel?.name : "SGS Datta Sannidhi"}
              </a>
              .<span className="muted"> This player link is separate from the exported video.</span>
            </p>
          )}
          {output.presentationReview?.closingCard?.youtubeClosing?.fullVideosUrl && (
            <p>
              Full videos:{" "}
              <a
                href={output.presentationReview.closingCard.youtubeClosing.fullVideosUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {new URL(
                  output.presentationReview.closingCard.youtubeClosing.fullVideosUrl,
                ).pathname.slice(1)}
              </a>
              . Subscribe using YouTube’s own Subscribe button on the Shorts channel.
            </p>
          )}
          {closingChannel && !downloadUrl && (
            <p>
              <strong>Closing-card channel:</strong> {closingChannel.name}. Its YouTube destination
              has not been configured yet. Connect the new channel and update the description before
              publishing. Viewers will use YouTube’s own Subscribe button.
            </p>
          )}
          <p>
            <strong>Original audio:</strong> Retained without dubbing. The import language setting
            is {spokenLanguage}; speech may switch languages within a recording. This setting is not
            a language check of this clip.
          </p>
          <p>
            <strong>Embedded subtitles:</strong>{" "}
            {embeddedCaption
              ? `${writtenLanguage}${embeddedCaption.translated ? " (translation)" : " (source language)"}. These are part of the video and remain visible when player CC is off.`
              : "None in this generated file."}
          </p>
          {output.mediaEdits && <StudioMediaSummary edits={output.mediaEdits} />}
          {output.captions.length > 0 && (
            <details>
              <summary>Optional player CC tracks</summary>
              <p>
                {output.captions
                  .map(
                    (caption) =>
                      `${DISTRIBUTION_LANGUAGE_NAMES[caption.language]}${caption.translated ? " (translation)" : " (source language)"}`,
                  )
                  .join(", ")}
                . Enable a track with the video player's CC control.
                {embeddedCaption &&
                  " This adds a second caption layer in this preview; it does not replace the embedded subtitles."}
              </p>
            </details>
          )}
        </section>
      ) : output.asset?.mimeType.startsWith("image/") ? (
        <section aria-labelledby={`media-heading-${output.id}`}>
          <h4 id={`media-heading-${output.id}`}>Image file</h4>
          <img
            src={`${media}/media`}
            alt={`Ashrama branded ${output.format}: ${output.title}`}
            style={{
              display: "block",
              width: "100%",
              maxHeight: 480,
              objectFit: "contain",
              borderRadius: 10,
            }}
          />
        </section>
      ) : null}
      <section aria-labelledby={`copy-heading-${output.id}`}>
        <h4 id={`copy-heading-${output.id}`}>{copyHeading}</h4>
        <p className="muted">
          {writtenLanguage} · Audience-facing {output.format === "blog" ? "article" : "copy"}
          {video ? ". Published alongside the video." : "."}
        </p>
        <p lang={output.language} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {output.body}
        </p>
      </section>
      {output.asset && (
        <>
          <p className="filename">{output.asset.filename}</p>
          {canDownload && (
            <a className="button" href={`${media}/download`} download>
              Download this {output.format}
            </a>
          )}
        </>
      )}
      {output.asset && (
        <section aria-label="Two-layer content review" style={{ marginBlock: 16 }}>
          <p>
            <strong>1. AI content review:</strong>{" "}
            {output.aiReview?.status === "PASSED"
              ? "Passed for this file version"
              : "No AI review recorded for this file version"}
          </p>
          {output.aiReview && (
            <details>
              <summary>What the AI checked</summary>
              <p>
                Complete opening and ending, context, attribution, faithful translations and
                source-supported copy.
              </p>
              <p>{output.aiReview.checks.reason}</p>
              <p className="muted">
                {output.aiReview.model} ·{" "}
                {output.aiReview.inputMode === "transcript_and_audio"
                  ? "Source audio and transcript checked"
                  : "Transcript checked"}
                {output.aiReview.humanFeedbackConsidered
                  ? " · Human correction comments considered"
                  : ""}
              </p>
            </details>
          )}
          {output.postArt && (
            <details>
              <summary>Illustration and excerpt screening</summary>
              <p>{output.postArt.checks.reason}</p>
              <p>{output.postArt.image.checks.reason}</p>
              <p className="muted">
                Context, exact excerpt, readability, branding and clipping checked against this
                image. {output.postArt.model} · {formatTimestamp(output.postArt.reviewedAt)}
              </p>
            </details>
          )}
          {output.presentationReview && (
            <details>
              <summary>Video and audio screening</summary>
              <p>
                Source framing, complete visible names, caption placement, relevant illustrations,
                and natural spoken boundaries checked against this rendered file.
              </p>
              <p>{output.presentationReview.checks.reason}</p>
              <p className="muted">
                {output.presentationReview.policy} · {output.presentationReview.model} ·{" "}
                {formatTimestamp(output.presentationReview.reviewedAt)} ·{" "}
                {output.presentationReview.repairs
                  ? "Automatically repaired and checked again"
                  : "Passed without a framing repair"}
              </p>
              {output.presentationReview.source.illustrations?.length ? (
                <ul>
                  {output.presentationReview.source.illustrations.map((shot) => (
                    <li key={`${shot.assetId}-${shot.startMs}`}>
                      {shot.assetId} · {(shot.startMs / 1000).toFixed(1)}–
                      {(shot.endMs / 1000).toFixed(1)}s: {shot.reason}
                      {shot.generated && (
                        <details>
                          <summary>Custom illustration and review</summary>
                          <p>{shot.prompt}</p>
                          <p>{shot.generated.checks.reason}</p>
                          <p className="muted">
                            {shot.generated.model} · {formatTimestamp(shot.generated.generatedAt)}
                            {" · "}Reviewed by {shot.generated.reviewerModel}
                          </p>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          )}
          <p>
            <strong>2. Human approval:</strong>{" "}
            {value.approval ? "Approved" : "Pending Content Approver review"}
          </p>
          <p className="muted">
            The AI check does not authorize publishing. The Content Approver checks the original
            speech, translation and context and makes the final decision.
          </p>
        </section>
      )}
      <details style={{ marginBlock: 16 }}>
        <summary>Internal review notes · not posted</summary>
        <p style={{ overflowWrap: "anywhere" }}>{output.rationale}</p>
        {output.warnings.length > 0 && (
          <ul>
            {output.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}

export function StudioPanel({
  content,
  capabilities,
  onOpenSource,
  onChooseSource,
  initialPackageId,
  onSelectionChange,
  scope,
  excludedMasterIds = [],
  bundle,
  onBackToBundle,
  onRenameBundle,
}: {
  scope?: "ongoing" | "complete";
  excludedMasterIds?: readonly string[];
  bundle?: {
    totalRecordings?: number;
    title: string;
    masterIds: readonly string[];
    packageIds?: readonly string[];
    playlistId?: string;
    sourceLinks?: Readonly<Record<string, string>>;
  };
  onBackToBundle?: () => void;
  onRenameBundle?: ReactNode;
  content?: ContentMaster;
  initialPackageId?: string | undefined;
  capabilities: readonly DistributionCapability[];
  onOpenSource?: (id: string, packageId?: string) => void;
  onSelectionChange?: (open: boolean) => void;
  onChooseSource?: () => void;
}) {
  const formatTimestamp = useHubTimestamp();
  const [listing, setListing] = useState<StudioListing | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialPackageId ?? null);
  const [detail, setDetail] = useState<StudioDetail | null>(null);
  const [filter, setFilter] = useState("active");
  const [seriesStep, setSeriesStep] = useState<number | null>(null);
  const [masterSearch, setMasterSearch] = useState("");
  const [additionalSource, setAdditionalSource] = useState<ContentMaster | null>(null);
  const [unstarted, setUnstarted] = useState<ContentMaster[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  const [regenerating, setRegenerating] = useState(false);
  const [reviewSelection, setReviewSelection] = useState<string[]>([]);
  useEffect(() => {
    if (detail?.package.id && detail.package.revision) setReviewSelection([]);
  }, [detail?.package.id, detail?.package.revision]);
  const reviewBlockers = reviewSelection.flatMap(
    (id) => detail?.outputBlockers?.[id] ?? detail?.blockers ?? [],
  );
  const [previewOutput, setPreviewOutput] = useState<string | null>(null);
  const [manualEdit, setManualEdit] = useState<{ id: string; sequence: number } | null>(null);
  const manualEditAvailable = Boolean(
    manualEdit && detail?.package.outputs.some((output) => output.id === manualEdit.id),
  );
  useEffect(() => {
    if (!manualEditAvailable || !detail?.package.id) return;
    const target = document.getElementById(`package-actions-${detail.package.id}`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, [manualEditAvailable, detail?.package.id]);
  const [bundlePreview, setBundlePreview] = useState<{
    packageId: string;
    outputId: string;
  } | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const latestLoad = useRef(0);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const openedMaster = useRef(Boolean(initialPackageId));
  const [focusPublishing, setFocusPublishing] = useState(false);
  const errorPanel = useRef<HTMLDivElement>(null);
  const canCreate = capabilities.includes("content.create");
  const canReview = capabilities.includes("content.review");
  const combinedRoles = canCreate && canReview;
  const canPublish = capabilities.includes("content.publish");
  const masterId = content?.id;
  const inBundle = Boolean(bundle);
  const playlistId = bundle?.playlistId;
  const load = useCallback(
    async (signal?: AbortSignal, preserveEdits = false) => {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000);
      const generation = ++latestLoad.current;
      const query = new URLSearchParams({ includeWithdrawn: "false" });
      if (masterId) query.set("masterId", masterId);
      if (playlistId) query.set("playlistId", playlistId);
      const response = await fetch(`${API}?${query}`, {
        cache: "no-store",
        signal: requestSignal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? "unavailable");
      if (generation !== latestLoad.current) return;
      setListing(data);
      if (masterId && !selectedId && !openedMaster.current) {
        openedMaster.current = true;
        const existing = data.packages.filter(
          (pkg: PublicStudioPackage) => pkg.status !== "DISCARDED",
        );
        if (existing.length === 1) setSelectedId(existing[0].id);
      }
      if (scope === "ongoing" && !masterId && !inBundle) {
        const masters: ContentMaster[] = [];
        let offset: number | null = 0;
        do {
          const sources: Response = await fetch(
            `/distribution/api/content?view=content&archive=active&offset=${offset}`,
            { cache: "no-store", signal: requestSignal },
          );
          if (!sources.ok) throw Error("unavailable");
          const page: { items: unknown; nextOffset: number | null } = await sources.json();
          masters.push(...contentMasterSchema.array().parse(page.items));
          offset = page.nextOffset ?? null;
        } while (offset !== null);
        if (generation !== latestLoad.current) return;
        setUnstarted(
          masters.filter(
            (source) =>
              !data.packages.some((pkg: PublicStudioPackage) => pkg.source.masterId === source.id),
          ),
        );
      }
      if (selectedId) {
        const current = await fetch(`${API}/${selectedId}`, {
          cache: "no-store",
          signal: requestSignal,
        });
        const next = await current.json();
        if (!current.ok) throw Error(next.error ?? "unavailable");
        if (generation === latestLoad.current && (!preserveEdits || !editingRef.current))
          setDetail(next);
      }
      if (generation === latestLoad.current) {
        setLoading(false);
        setRefreshError("");
        setLastChecked(new Date().toISOString());
      }
    },
    [masterId, selectedId, scope, playlistId, inBundle],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!editingRef.current)
        await load(abort.signal, true).catch(() => {
          if (!abort.signal.aborted) {
            setRefreshError(
              "Unable to refresh package progress. Reconnecting automatically; saved work is retained.",
            );
            setLoading(false);
          }
        });
      if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
      latestLoad.current++;
    };
  }, [load]);
  useEffect(() => {
    onSelectionChange?.(Boolean(selectedId));
    if (selectedId) heading.current?.focus();
  }, [selectedId, onSelectionChange]);

  useEffect(() => {
    if (!focusPublishing || detail?.package.status !== "APPROVED") return;
    const target = document.getElementById(`package-publishing-${detail.package.id}`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
    setFocusPublishing(false);
  }, [focusPublishing, detail?.package.status, detail?.package.id]);
  useEffect(() => {
    if (!error) return;
    errorPanel.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    errorPanel.current?.focus({ preventScroll: true });
  }, [error]);

  async function perform(action: string, command: unknown, id = selectedId) {
    setBusy(true);
    setError("");
    setNotice("");
    let failureCode = "STUDIO_ACTION_UNCONFIRMED";
    let failureOperator: StudioBlockedOperator | null = null;
    try {
      const response = await fetch(id ? `${API}/${id}/${action}` : API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      if (!response.ok) {
        failureCode = data.error ?? "unavailable";
        failureOperator = data.operator ?? null;
        throw Error("STUDIO_ACTION_REJECTED");
      }
      if (data.package) setSelectedId(data.package.id);
      if (action === "create") setAdditionalSource(null);
      setEditing(false);
      setRegenerating(false);
      setDiscarding(null);
      if (action === "review" && data.package?.status === "APPROVED") setFocusPublishing(true);
      setNotice(
        action === "review" && data.package?.status === "APPROVED"
          ? "Approval saved. Continue below to publishing."
          : action === "publish"
            ? detail?.package.isTest
              ? "Test publication was queued. Nothing is posted to social channels in the test workspace."
              : "Publication requested. Check each channel below for its result."
            : action === "regenerate" ||
                action === "create" ||
                (action === "revise" && data.package?.status === "QUEUED")
              ? "Generation is queued. You can leave this page and return to the package."
              : "Package updated.",
      );
      await load().catch(() =>
        setRefreshError(
          "Your action was saved, but progress could not refresh. Reconnecting automatically; do not submit it again.",
        ),
      );
      return data;
    } catch {
      setError(studioBlockerMessage(failureCode, failureOperator));
      await load().catch(() => undefined);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function select(value: PublicStudioPackage) {
    setBundlePreview(null);
    setPreviewOutput(null);
    setAdditionalSource(null);
    setSelectedId(value.id);
    setDetail(null);
    setEditing(false);
    setRegenerating(false);
    setDiscarding(null);
    setError("");
    setNotice("");
  }
  const value = detail?.package;
  const readiness = detail?.readiness ?? listing?.readiness;
  const matchesSearch = (title: string) =>
    title.toLocaleLowerCase().includes(masterSearch.trim().toLocaleLowerCase());
  const visible =
    listing?.packages
      .filter(
        (item) =>
          item.status !== "DISCARDED" &&
          !excludedMasterIds.includes(item.source.masterId) &&
          (!bundle ||
            (bundle.masterIds.includes(item.source.masterId) &&
              (!bundle.packageIds || bundle.packageIds.includes(item.id)))) &&
          (scope === "complete"
            ? item.status === "APPROVED"
            : scope === "ongoing"
              ? item.status !== "APPROVED"
              : true) &&
          (filter === "active" ||
            item.status === filter ||
            item.outputs.some((o) => o.workflow && studioFileStatus(item, o) === filter)) &&
          matchesSearch(`${studioSourceName(item)} ${item.source.title}`),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
  const visibleUnstarted = unstarted.filter(
    (source) =>
      !excludedMasterIds.includes(source.id) &&
      !bundle &&
      (filter === "active" || filter === "SETUP") &&
      matchesSearch(`${contentDisplayName(source)} ${source.title}`),
  );
  const masterGroups = [
    ...visible
      .reduce((groups, item) => {
        const siblings = groups.get(item.source.masterId) ?? [];
        siblings.push(item);
        groups.set(item.source.masterId, siblings);
        return groups;
      }, new Map<string, PublicStudioPackage[]>())
      .values(),
  ];
  const siblingPackages = value
    ? (listing?.packages.filter(
        (item) =>
          item.source.masterId === value.source.masterId &&
          (!bundle?.packageIds || bundle.packageIds.includes(item.id)),
      ) ?? [])
    : [];
  const pending =
    listing?.packages.filter((item) =>
      item.outputs.some((o) => studioFileStatus(item, o) === "IN_REVIEW"),
    ).length ?? 0;
  const bundlePackages = bundle
    ? bundle.masterIds.flatMap((id) =>
        (listing?.packages ?? []).filter(
          (item) =>
            item.source.masterId === id &&
            item.status !== "DISCARDED" &&
            (scope !== "complete" || item.status === "APPROVED") &&
            (!bundle.packageIds || bundle.packageIds.includes(item.id)),
        ),
      )
    : [];
  const newRequest = studioGenerationDefaults(content);
  const sourcePermissions = content
    ? studioExternalProcessingDecision(
        content,
        value?.request ?? newRequest,
        new Date().toISOString(),
      )
    : null;

  if (sourcePermissions?.allowed && !value && !newRequest.channels.length) {
    sourcePermissions.allowed = false;
    sourcePermissions.reason = "NO_PERMITTED_CHANNELS";
  }

  if (bundle && !selectedId) {
    const previewPackage = bundlePackages.find((item) => item.id === bundlePreview?.packageId);
    return (
      <section className="panel" aria-label="Intelligent content" style={{ minWidth: 0 }}>
        <div className="actions wrap series-context-heading">
          <strong>{bundle.title}</strong>
          {onRenameBundle}
          <button className="button" type="button" onClick={onBackToBundle}>
            Back to playlist overview
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {lastChecked && (
          <p className="muted">
            Last checked: <time dateTime={lastChecked}>{formatTimestamp(lastChecked)}</time>
          </p>
        )}
        {refreshError && (
          <output className="notice">
            <span>{refreshError} Displayed statuses may be out of date.</span>
            <button
              type="button"
              className="button"
              onClick={() => void load(undefined, true).catch(() => {})}
            >
              Refresh progress
            </button>
          </output>
        )}
        {!listing ? (
          <output>
            {loading
              ? "Loading saved playlist files…"
              : "The saved file list could not be loaded. Your files have not been removed. Use Refresh progress to try again."}
          </output>
        ) : (
          <>
            {scope !== "complete" && (
              <StudioProgressSummary
                packages={bundlePackages}
                publications={listing?.publications ?? []}
                totalRecordings={bundle.totalRecordings}
                selectedStep={seriesStep}
                onStep={setSeriesStep}
              />
            )}
            <PlaylistFiles
              sourceLinks={bundle.sourceLinks}
              showHandoff={false}
              workflowStep={seriesStep}
              onClearStep={() => setSeriesStep(null)}
              publications={listing?.publications ?? []}
              readiness={listing?.readiness}
              playlistId={bundle.playlistId}
              onRefresh={() => load(undefined, true)}
              totalRecordings={bundle.totalRecordings}
              packages={bundlePackages}
              canCurate={canCreate}
              canReview={canReview}
              canPublish={canPublish}
              onOpen={select}
              onPreview={(item, outputId) => setBundlePreview({ packageId: item.id, outputId })}
            />
          </>
        )}
        {previewPackage && bundlePreview && (
          <StudioPreviewDialog onClose={() => setBundlePreview(null)}>
            <StudioPreviewLoader
              key={`${previewPackage.id}:${bundlePreview.outputId}`}
              packageId={previewPackage.id}
              outputId={bundlePreview.outputId}
              revision={previewPackage.revision}
            >
              {(loadedPackage, preview) => (
                <>
                  <div className="preview-file-heading">
                    <h3>{preview.title}</h3>
                    {preview.included && studioCanEditFile(loadedPackage, preview, capabilities) ? (
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => {
                          select(loadedPackage);
                          setManualEdit({
                            id: preview.id,
                            sequence: (manualEdit?.sequence ?? 0) + 1,
                          });
                        }}
                      >
                        Edit this file
                      </button>
                    ) : (
                      <button
                        className="button"
                        type="button"
                        onClick={() => select(loadedPackage)}
                      >
                        Open recording workflow
                      </button>
                    )}
                  </div>
                  <StudioOutputPreview
                    value={loadedPackage}
                    output={preview}
                    canDownload={
                      canPublish && studioFileStatus(loadedPackage, preview) === "APPROVED"
                    }
                  />
                </>
              )}
            </StudioPreviewLoader>
          </StudioPreviewDialog>
        )}
      </section>
    );
  }

  return (
    <section
      className="panel"
      aria-label="Intelligent content"
      id={content ? `studio-${content.id}` : undefined}
      style={{ marginTop: 24, minWidth: 0 }}
    >
      {bundle && (
        <PlaylistReviewNavigation
          sourceLinks={bundle.sourceLinks}
          title={bundle.title}
          packages={bundlePackages}
          selectedId={selectedId}
          completed={scope === "complete"}
          disabled={busy || editing || regenerating}
          onSelect={select}
          onBack={onBackToBundle}
          onAllFiles={() => {
            setSelectedId(null);
            setDetail(null);
            setPreviewOutput(null);
            setError("");
            setNotice("");
          }}
        />
      )}
      {value && !bundle && (
        <SeriesNavigation
          masterId={value.source.masterId}
          disabled={busy || editing || regenerating}
        />
      )}
      <div
        className="actions wrap"
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 className="workspace-title" ref={heading} tabIndex={-1}>
            {value
              ? studioSourceName(value)
              : content
                ? "Channel content from this master"
                : scope === "complete"
                  ? "Approved channel content"
                  : "Individual masters"}
          </h2>
          {value && canCreate && (
            <WorkspaceName
              kind="master"
              id={value.source.masterId}
              title={studioSourceName(value)}
              name={value.workspaceName}
              onSaved={() => load(undefined, true)}
            />
          )}
        </div>
        {selectedId && !bundle && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
              setNotice("");
              setError("");
              setPreviewOutput(null);
              setAdditionalSource(null);
              heading.current?.focus();
            }}
          >
            {content ? "Back to this master" : "Back to masters"}
          </button>
        )}
      </div>
      {(value || (content && listing?.packages.length === 0)) && (
        <StudioWorkflow
          value={value}
          combinedRoles={combinedRoles}
          reviewerOnly={canReview && !canCreate}
          hasMaster={Boolean(content)}
          permissionsReady={sourcePermissions?.allowed}
          publications={detail?.publications ?? []}
          nextLabel={
            !value
              ? sourcePermissions && !sourcePermissions.allowed
                ? "confirm permission"
                : content
                  ? "generate drafts"
                  : "choose a master"
              : value.status === "IN_REVIEW"
                ? canReview
                  ? "review and approve"
                  : "waiting for Content Approver"
                : value.status === "APPROVED"
                  ? canPublish
                    ? value.isTest
                      ? "test publishing"
                      : "check publishing setup and publish"
                    : "waiting for Content Approver"
                  : value.status === "CHANGES_REQUESTED"
                    ? "revise and resubmit"
                    : ["QUEUED", "GENERATING"].includes(value.status)
                      ? "waiting for generation"
                      : value.status === "FAILED"
                        ? studioNeedsSuitabilityReview(value.failure)
                          ? "review source and guidance"
                          : "check generation issue"
                        : canCreate
                          ? "check and submit"
                          : "awaiting Curator submission"
          }
          nextDisabled={
            busy ||
            Boolean(
              value &&
                (["QUEUED", "GENERATING"].includes(value.status) ||
                  (value.status === "IN_REVIEW" && !canReview) ||
                  (value.status === "APPROVED" && !canPublish) ||
                  (["DRAFT", "CHANGES_REQUESTED", "FAILED"].includes(value.status) && !canCreate)),
            ) ||
            (!value && !canCreate)
          }
          onNext={() => {
            if (!value && !content) {
              onChooseSource?.();
              return;
            }
            if (!value && content && sourcePermissions && !sourcePermissions.allowed) {
              onOpenSource?.(content.id);
              return;
            }
            const target = document.getElementById(
              value?.status === "FAILED"
                ? studioNeedsSuitabilityReview(value.failure)
                  ? `package-actions-${value.id}`
                  : `generation-issue-${value.id}`
                : value
                  ? value.status === "APPROVED"
                    ? `package-publishing-${value.id}`
                    : `package-actions-${value.id}`
                  : `studio-generation-${content?.id}`,
            );
            if (target instanceof HTMLDetailsElement) target.open = true;
            target?.scrollIntoView({ block: "start", behavior: "smooth" });
            target?.focus({ preventScroll: true });
          }}
          onStep={(step) => {
            if (step === 1) {
              const source = value?.source.masterId ?? content?.id;
              if (source && onOpenSource) onOpenSource(source, value?.id);
              else onChooseSource?.();
              return;
            }
            const target = document.getElementById(
              value
                ? step === 6
                  ? `package-publishing-${value.id}`
                  : step === 3
                    ? `package-files-${value.id}`
                    : `package-actions-${value.id}`
                : `studio-generation-${content?.id}`,
            );
            if (target instanceof HTMLDetailsElement) target.open = true;
            target?.scrollIntoView({ block: "start", behavior: "smooth" });
            target?.focus({ preventScroll: true });
          }}
        />
      )}
      {value && (
        <div className="actions wrap" aria-label="Delete content">
          <StorageCleanup
            key={`cleanup-package-${value.id}`}
            kind="package"
            id={value.id}
            onDeleted={() => {
              setSelectedId(null);
              setDetail(null);
            }}
          />
          {!content && (
            <StorageCleanup
              key={`cleanup-master-${value.source.masterId}`}
              kind="master"
              id={value.source.masterId}
              onDeleted={() => {
                setSelectedId(null);
                setDetail(null);
              }}
            />
          )}
        </div>
      )}
      {value && siblingPackages.length > 1 && (
        <details open>
          <summary>All content in this master’s workspace</summary>
          <label className="package-selection">
            Curation batches from this master
            <select
              value={value.id}
              onChange={(event) => {
                const item = siblingPackages.find(
                  (candidate) => candidate.id === event.target.value,
                );
                if (item) select(item);
              }}
            >
              {siblingPackages.map((item) => (
                <option key={item.id} value={item.id}>
                  {studioStatusLabel(item)} · {formatTimestamp(item.createdAt)} ·{" "}
                  {item.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </details>
      )}
      {value?.status === "DRAFT" && canReview && !canCreate && (
        <aside className="workflow-context-note" aria-label="Curator handoff">
          <p>
            The Curator must open this recording under Continue Existing Curation, check its files,
            then choose <strong>Submit selected files for review</strong> in step 3. You can then
            use
            <strong> Review &amp; approve</strong> in step 4.
          </p>
          <p>
            Approval covers all included files from this recording. After approval, step 6 lets you
            choose the target account and post them.
          </p>
          {value.isTest && (
            <p className="muted">This is a test workspace; it does not upload videos to YouTube.</p>
          )}
        </aside>
      )}
      {detail && value && ["IN_REVIEW", "APPROVED"].includes(value.status) && (
        <StudioPublishing
          key={value.id}
          detail={detail}
          canPublish={canPublish}
          canManage={capabilities.includes("operations.manage")}
          busy={busy}
          onPublish={(accounts, outputIds) =>
            void perform("publish", { expectedRevision: value.revision, accounts, outputIds })
          }
          onRefresh={() => void load().catch(() => setError(studioMessage("unavailable")))}
        />
      )}
      {value?.provenance?.discovery && (
        <details className="workflow-context-note" aria-label="Discovery coverage">
          <summary>Section-by-section discovery completed</summary>
          <p>
            {value.provenance.discovery.sections.length} sections reviewed;{" "}
            {value.provenance.discovery.sections.reduce((n, s) => n + s.accepted, 0)} new distinct
            messages selected;{" "}
            {value.provenance.discovery.sections.reduce((n, s) => n + s.duplicates, 0)} overlapping
            or repeated messages excluded. This records the review coverage, not a guarantee that
            every possible teaching was found.
          </p>
        </details>
      )}
      {canCreate && value?.status === "FAILED" && value.generation?.mode === "discover" && (
        <p>
          Existing Shorts are unchanged.{" "}
          <button
            className="button"
            type="button"
            disabled={busy || !readiness?.generation.available}
            onClick={() =>
              void perform("regenerate", { expectedRevision: value.revision, mode: "discover" })
            }
          >
            Resume finding more Shorts
          </button>
        </p>
      )}
      {value && <StudioGenerationPreviews packages={[value]} />}
      {value?.generationProgress && (
        <div
          id={`${value.generationProgress.errorCode === value.failure ? "generation-issue" : "generation-progress"}-${value.id}`}
          tabIndex={-1}
        >
          <StudioGenerationProgressView
            value={value.generationProgress}
            status={value.status}
            formatTimestamp={formatTimestamp}
          />
        </div>
      )}
      {value?.failure && value.generationProgress?.errorCode !== value.failure && (
        <output
          id={`generation-issue-${value.id}`}
          tabIndex={-1}
          className={studioNeedsSuitabilityReview(value.failure) ? "notice" : "notice error"}
          style={{ display: "block" }}
        >
          {studioMessage(value.failure)}
        </output>
      )}
      {content && sourcePermissions && !sourcePermissions.allowed && (
        <div className="source-next-step">
          <div>
            <strong>Next: confirm this master's permissions</strong>
            <p>{studioMessage(sourcePermissions.reason ?? "RIGHTS_MISSING")}</p>
            <p className="muted">
              External AI processing requires current public, worldwide permission covering the
              requested channels. Record the authorization actually granted for this source.
            </p>
          </div>
          {onOpenSource && (
            <button
              type="button"
              className="button primary"
              onClick={() => onOpenSource(content.id)}
            >
              Review master permissions
            </button>
          )}
        </div>
      )}
      {content && sourcePermissions?.allowed && content.state !== "APPROVED" && (
        <p className="muted">
          Source permissions are recorded. Master permission approval takes place with the
          channel-file review in step 4.
        </p>
      )}
      {(value || content) && readiness && !readiness.generation.available && canCreate && (
        <output className="notice generation-status">
          Generation is currently unavailable. You can upload a master, record its permissions and
          review existing outputs.{" "}
          {studioMessage(readiness.generation.reason ?? "GENERATION_NOT_CONFIGURED")}
        </output>
      )}
      {error && (
        <div className="notice error" role="alert" ref={errorPanel} tabIndex={-1}>
          {error}
          <button
            type="button"
            className="button"
            onClick={() =>
              void load()
                .then(() => setError(""))
                .catch(() => setError(studioMessage("unavailable")))
            }
          >
            Refresh package
          </button>
        </div>
      )}
      {refreshError && <output className="notice">{refreshError}</output>}
      {notice &&
        (!notice.startsWith("Generation is queued.") ||
          !value ||
          ["QUEUED", "GENERATING"].includes(value.status)) && (
          <output className="notice" style={{ display: "block" }}>
            {notice.startsWith("Generation is queued.") && value?.status === "GENERATING"
              ? "Generating channel content. This may take several minutes; you can leave and return to this package."
              : notice}
          </output>
        )}
      {!selectedId &&
        content &&
        canCreate &&
        content.state !== "WITHDRAWN" &&
        (content.currentVersion.mimeType === "video/mp4" ||
          content.currentVersion.mimeType.startsWith("audio/")) && (
          <details
            id={`studio-generation-${content.id}`}
            tabIndex={-1}
            open={!listing?.packages.length}
          >
            <summary>Generate channel content from this master</summary>
            <p>
              The content layer selects suitable formats for the {newRequest.channels.length}{" "}
              channels permitted for this master. Choose languages and optional guidance once.
            </p>
            <p className="muted" aria-label="Permitted generation channels">
              {newRequest.channels.map(studioChannelLabel).join(", ") ||
                "No supported channel is permitted yet."}
            </p>
            {content.rights && newRequest.channels.length < STUDIO_CHANNELS.length && (
              <p className="muted">
                Excluded by this master’s permissions:{" "}
                {STUDIO_CHANNELS.filter((channel) => !newRequest.channels.includes(channel))
                  .map(studioChannelLabel)
                  .join(", ")}
                . These exclusions do not block the permitted channels.
              </p>
            )}
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (busy || !sourcePermissions?.allowed || !readiness?.generation.available) return;
                const fields = new FormData(event.currentTarget);
                if (!fields.getAll("channel").length) {
                  setError("Choose at least one target channel.");
                  return;
                }
                if (!fields.getAll("language").length) {
                  setError("Choose at least one output language.");
                  return;
                }
                void perform(
                  "create",
                  {
                    masterId: content.id,
                    expectedSourceRevision: content.revision,
                    request: generationFields(fields),
                  },
                  null,
                );
              }}
            >
              <fieldset disabled={busy}>
                <GenerationFields
                  showChannels
                  request={newRequest}
                  translation={readiness?.generation.translation ?? false}
                  localDrafting={
                    readiness?.generation.intelligence === "Local source-based drafting"
                  }
                />
                {(!sourcePermissions?.allowed || !readiness?.generation.available) && (
                  <div
                    id={`generation-blocker-${content.id}`}
                    style={{ display: "block" }}
                    className="notice"
                    aria-live="polite"
                  >
                    <strong>Generation is blocked:</strong>
                    <ul>
                      {!sourcePermissions?.allowed && (
                        <li>
                          {studioMessage(sourcePermissions?.reason ?? "RIGHTS_MISSING")} Use “Review
                          master permissions” to fix and save them.
                        </li>
                      )}
                      {!readiness?.generation.available && (
                        <li>
                          {readiness
                            ? studioMessage(
                                readiness.generation.reason ?? "GENERATION_NOT_CONFIGURED",
                              )
                            : "Checking generation service readiness…"}
                        </li>
                      )}
                    </ul>
                    {!sourcePermissions?.allowed && onOpenSource && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => onOpenSource(content.id)}
                      >
                        Review master permissions
                      </button>
                    )}
                  </div>
                )}
                <button
                  type="submit"
                  className="button primary"
                  aria-describedby={
                    !sourcePermissions?.allowed || !readiness?.generation.available
                      ? `generation-blocker-${content.id}`
                      : undefined
                  }
                  disabled={!sourcePermissions?.allowed || !readiness?.generation.available}
                >
                  Generate channel package
                </button>
              </fieldset>
            </form>
          </details>
        )}
      {!selectedId && (!content || Boolean(listing?.packages.length)) && (
        <>
          <div className="fields" style={{ marginTop: 20 }}>
            {!content && (
              <label>
                Search masters
                <input
                  type="search"
                  value={masterSearch}
                  placeholder="Search by master title"
                  onChange={(event) => setMasterSearch(event.target.value)}
                />
              </label>
            )}
            {scope !== "complete" && (
              <label>
                Curation status
                <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="active">All ongoing curations</option>
                  {scope === "ongoing" && <option value="SETUP">Master setup</option>}
                  <option value="IN_REVIEW">Awaiting Content Approver review ({pending})</option>
                  <option value="CHANGES_REQUESTED">Changes requested</option>
                  {!scope && <option value="APPROVED">Approved packages</option>}
                  <option value="FAILED">Generation needs attention</option>
                </select>
              </label>
            )}
          </div>
          {loading ? (
            <output>Loading masters…</output>
          ) : visible.length || visibleUnstarted.length ? (
            <div className="library-grid" aria-label="Master selection">
              {masterGroups.map((packages) => {
                const item = packages[0];
                if (!item) return null;
                const progress = studioWorkflow({ package: item });
                const currentStep = progress.steps.find((step) => step.number === progress.current);
                return (
                  <button
                    type="button"
                    key={item.source.masterId}
                    className="content-card"
                    onClick={() => select(item)}
                  >
                    <div className="card-body">
                      <h3 style={{ overflowWrap: "anywhere" }}>{studioSourceName(item)}</h3>
                      <span className="badge">{studioStatusLabel(item)}</span>
                      {scope !== "complete" && currentStep && (
                        <p>
                          Step {currentStep.number} of 6 · {currentStep.title}
                        </p>
                      )}
                      <p>
                        {item.outputs.filter((output) => output.included).length} derived outputs ·{" "}
                        {
                          new Set(
                            item.outputs
                              .filter((output) => output.included)
                              .map((output) => output.channel),
                          ).size
                        }{" "}
                        channels
                      </p>
                      {packages.length > 1 && (
                        <p className="muted">
                          {packages.length} curations · opens the most recently updated. Choose
                          another inside this workspace.
                        </p>
                      )}
                      {item.feedback.at(-1)?.comment && (
                        <p className="muted queue-comment">{item.feedback.at(-1)?.comment}</p>
                      )}
                      <p className="muted">Updated {formatTimestamp(item.updatedAt)}</p>
                    </div>
                    <span className="card-next">
                      {scope === "complete" ? "View approved files →" : "Continue this master →"}
                    </span>
                  </button>
                );
              })}
              {visibleUnstarted.map((source) => {
                const permissions = studioExternalProcessingDecision(
                  source,
                  studioGenerationDefaults(source),
                  new Date().toISOString(),
                );
                return (
                  <button
                    type="button"
                    className="content-card"
                    key={source.id}
                    onClick={() => onOpenSource?.(source.id)}
                  >
                    <div className="card-body">
                      <h3 style={{ overflowWrap: "anywhere" }}>{contentDisplayName(source)}</h3>
                      <span className="badge">
                        {permissions.allowed ? "Ready to generate" : "Permissions needed"}
                      </span>
                      <p>
                        {permissions.allowed
                          ? "Step 2 of 6 · Generate channel drafts"
                          : "Step 1 of 6 · Choose master & permissions"}
                      </p>
                      <p>No channel drafts generated yet.</p>
                      <p className="muted">Updated {formatTimestamp(source.updatedAt)}</p>
                    </div>
                    <span className="card-next">Continue this master →</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p>
              {masterSearch.trim() || filter !== "active"
                ? "No masters match these filters. Clear the search or choose another status."
                : scope === "complete"
                  ? "No completed curations yet. Files appear here after Content Approver approval."
                  : "No masters are under curation yet. Use Start New Curation to import a video or upload a recording."}
            </p>
          )}
          {!loading &&
            !content &&
            canCreate &&
            onChooseSource &&
            !listing?.packages.length &&
            !unstarted.length && (
              <button type="button" className="button" onClick={onChooseSource}>
                Start New Curation
              </button>
            )}
        </>
      )}
      {selectedId && !value && <output>Loading package…</output>}
      {value?.status === "APPROVED" && (
        <p className="notice">
          Approved and locked. Editing and regeneration are closed, including for users holding both
          roles.
        </p>
      )}
      {value && detail && (
        <>
          <div className="actions wrap">
            <span className="badge">
              {combinedRoles && value.status === "IN_REVIEW"
                ? "Ready for your approval review"
                : studioStatusLabel(value)}
            </span>

            {onOpenSource && (
              <button
                type="button"
                className="button"
                onClick={() => onOpenSource(value.source.masterId, value.id)}
              >
                Permission to use this master
              </button>
            )}
          </div>
          {canCreate && onOpenSource && value.status === "APPROVED" && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const response = await fetch(
                    `/distribution/api/content/${value.source.masterId}/detail`,
                    { cache: "no-store" },
                  );
                  if (!response.ok) throw Error("unavailable");
                  setAdditionalSource(contentMasterSchema.parse((await response.json()).content));
                } catch {
                  setError(studioMessage("unavailable"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create additional content
            </button>
          )}
          {additionalSource && (
            <form
              className="panel editor"
              aria-label="Create additional content"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !readiness?.generation.available) return;
                const fields = new FormData(event.currentTarget);
                if (!fields.getAll("channel").length) {
                  setError("Choose at least one target channel.");
                  return;
                }
                if (!fields.getAll("language").length) {
                  setError("Choose at least one output language.");
                  return;
                }
                void perform(
                  "create",
                  {
                    masterId: additionalSource.id,
                    expectedSourceRevision: additionalSource.revision,
                    request: generationFields(fields),
                  },
                  null,
                );
              }}
            >
              <h3>Create additional content from this master</h3>
              <p>New drafts need approval. Existing approved files stay locked.</p>
              <fieldset disabled={busy}>
                <GenerationFields
                  request={{
                    ...studioGenerationDefaults(additionalSource),
                    instructions: "",
                  }}
                  translation={readiness?.generation.translation ?? false}
                  localDrafting={
                    readiness?.generation.intelligence === "Local source-based drafting"
                  }
                />
                <fieldset>
                  <legend>Target channels</legend>
                  {studioGenerationDefaults(additionalSource).channels.map((channel) => (
                    <label key={channel} style={checkStyle}>
                      <input type="checkbox" name="channel" value={channel} style={boxStyle} />
                      {studioChannelLabel(channel)}
                    </label>
                  ))}
                </fieldset>
                <p>
                  Select at least one channel and use guidance above to describe the new passage,
                  audience or format.
                </p>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!readiness?.generation.available}
                >
                  Generate additional drafts
                </button>
              </fieldset>
              <button className="button" type="button" onClick={() => setAdditionalSource(null)}>
                Cancel
              </button>
            </form>
          )}
          {detail.blockers.length > 0 && !studioNeedsSuitabilityReview(value.failure) && (
            <div className="notice" style={{ display: "block" }}>
              <strong>Before approval or publication</strong>
              <ul>
                {detail.blockers.map((blocker) => (
                  <li key={blocker}>{studioMessage(blocker)}</li>
                ))}
              </ul>
            </div>
          )}
          <div id={`package-files-${value.id}`} tabIndex={-1}>
            <StudioQualitySelection messages={value.provenance?.excludedMessages} />
            {!["IN_REVIEW", "APPROVED"].includes(value.status) && (
              <StudioDraftPostingHistory detail={detail} />
            )}
            {value.outputs.length > 0 && (
              <StudioLineage
                value={value}
                publications={detail.publications}
                onPreview={setPreviewOutput}
              />
            )}
          </div>
          {previewOutput && (
            <StudioPreviewDialog onClose={() => setPreviewOutput(null)}>
              <div className="preview-paging actions wrap">
                <span>
                  File {value.outputs.findIndex((output) => output.id === previewOutput) + 1} of{" "}
                  {value.outputs.length}
                </span>
                <button
                  className="button"
                  type="button"
                  disabled={value.outputs[0]?.id === previewOutput}
                  onClick={() =>
                    setPreviewOutput(
                      value.outputs[
                        value.outputs.findIndex((output) => output.id === previewOutput) - 1
                      ]?.id ?? previewOutput,
                    )
                  }
                >
                  Previous file
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={value.outputs.at(-1)?.id === previewOutput}
                  onClick={() =>
                    setPreviewOutput(
                      value.outputs[
                        value.outputs.findIndex((output) => output.id === previewOutput) + 1
                      ]?.id ?? previewOutput,
                    )
                  }
                >
                  Next file
                </button>
              </div>
              {value.outputs
                .filter((output) => output.id === previewOutput)
                .map((output) => (
                  <article
                    className="variant-card selected-output-preview"
                    id={`output-preview-${output.id}`}
                    tabIndex={-1}
                    key={output.id}
                    style={{ opacity: output.included ? 1 : 0.65 }}
                  >
                    <div className="actions wrap">
                      <strong>{studioOutputChannelLabel(output)}</strong>
                      <span className="badge">
                        {output.format} · {output.language}
                      </span>
                      {!output.included && <span className="badge">Discarded output</span>}
                    </div>
                    <h3 style={{ overflowWrap: "anywhere" }}>{output.title}</h3>
                    {output.included && studioCanEditFile(value, output, capabilities) && (
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            editing &&
                            !window.confirm("Discard unsaved edits to the current file?")
                          )
                            return;
                          setPreviewOutput(null);
                          setManualEdit({
                            id: output.id,
                            sequence: (manualEdit?.sequence ?? 0) + 1,
                          });
                          window.setTimeout(() => {
                            const editor = document.getElementById(`package-actions-${value.id}`);
                            editor?.scrollIntoView({ block: "start", behavior: "smooth" });
                            editor?.focus();
                          }, 0);
                        }}
                      >
                        Edit this file
                      </button>
                    )}
                    <StudioOutputPreview
                      value={value}
                      output={output}
                      canDownload={
                        canPublish &&
                        studioFileStatus(value, output) === "APPROVED" &&
                        output.included
                      }
                    />
                    {output.included &&
                      studioCanDiscard(studioFileStatus(value, output), capabilities, "output") && (
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={() => {
                            setPreviewOutput(null);
                            setDiscarding(output.id);
                            window.setTimeout(
                              () =>
                                document
                                  .getElementById(`package-actions-${value.id}`)
                                  ?.scrollIntoView({ block: "start" }),
                              0,
                            );
                          }}
                        >
                          Discard output
                        </button>
                      )}
                    {detail.publications
                      .filter(
                        (publication) =>
                          publication.packageId === value.id &&
                          publication.packageRevision === value.revision &&
                          publication.outputId === output.id &&
                          publication.channel === output.channel &&
                          publication.isTest === value.isTest,
                      )
                      .map((publication) => (
                        <div key={publication.id} aria-live="polite" style={{ marginTop: 16 }}>
                          <strong>{STUDIO_PUBLICATION_LABELS[publication.status]}</strong>
                          {publication.error && <p>{studioMessage(publication.error)}</p>}
                          {publication.remoteUrl && (
                            <a
                              className="button"
                              href={publication.remoteUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open published content
                            </a>
                          )}
                        </div>
                      ))}
                  </article>
                ))}
            </StudioPreviewDialog>
          )}
          <section
            className="package-actions"
            id={`package-actions-${value.id}`}
            tabIndex={-1}
            aria-label="Package actions"
          >
            <StudioCorrectionComparison value={value} />
            {value.outputs.some((o) => studioCanEditFile(value, o, capabilities)) && (
              <StudioCorrections
                key={`${value.id}-${value.revision}-${manualEdit?.sequence ?? 0}`}
                initialOutputId={
                  value.outputs.some((output) => output.id === manualEdit?.id)
                    ? manualEdit?.id
                    : undefined
                }
                onEditingChange={setEditing}
                value={value}
                busy={busy}
                available={readiness?.generation.available ?? false}
                onAction={perform}
              />
            )}
            {studioCanEdit(value.status, capabilities) &&
              !value.outputs.length &&
              studioNeedsSuitabilityReview(value.failure) && (
                <StudioSourceRecovery
                  key={`${value.id}-${value.revision}`}
                  value={value}
                  busy={busy}
                  available={readiness?.generation.available ?? false}
                  onAction={perform}
                />
              )}
            {studioCanEdit(value.status, capabilities) &&
              !value.outputs.length &&
              !studioNeedsSuitabilityReview(value.failure) && (
                <button
                  className="button"
                  type="button"
                  disabled={busy || !readiness?.generation.available}
                  onClick={() => void perform("regenerate", { expectedRevision: value.revision })}
                >
                  Retry generation
                </button>
              )}
            {canCreate &&
              value.outputs.some((o) => studioCanEditFile(value, o, capabilities)) &&
              !editing &&
              !regenerating && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const outputIds = form.getAll("submitOutput");
                    if (!outputIds.length) {
                      setError("Select the files to submit for review.");
                      return;
                    }
                    void perform("submit", {
                      expectedRevision: value.revision,
                      outputIds,
                      comment: String(form.get("comment") ?? ""),
                    });
                  }}
                >
                  <fieldset disabled={busy}>
                    <legend>Files to submit</legend>
                    {value.outputs
                      .filter((o) => studioCanEditFile(value, o, capabilities))
                      .map((o) => (
                        <label key={o.id} style={checkStyle}>
                          <input
                            type="checkbox"
                            name="submitOutput"
                            value={o.id}
                            style={boxStyle}
                          />
                          {o.title}
                        </label>
                      ))}
                    <label>
                      {combinedRoles ? "Curation notes (optional)" : "Note for Content Approver"}
                      <textarea name="comment" rows={3} maxLength={4000} />
                    </label>
                    <button
                      type="submit"
                      className="button primary"
                      disabled={!value.outputs.some((output) => output.included)}
                    >
                      Submit selected files for review
                    </button>
                  </fieldset>
                </form>
              )}
            {canReview && value.outputs.some((o) => studioFileStatus(value, o) === "IN_REVIEW") && (
              <>
                <StudioSourceReview
                  key={value.source.masterId}
                  masterId={value.source.masterId}
                  onApproved={load}
                />
                <form
                  key={`review-${value.id}-${value.revision}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const submitter = (event.nativeEvent as SubmitEvent)
                      .submitter as HTMLButtonElement | null;
                    const decision = submitter?.value === "REJECTED" ? "REJECTED" : "APPROVED";
                    const comment = String(form.get("comment") ?? "").trim();
                    if (!form.getAll("reviewOutput").length) {
                      setError("Select the files to review.");
                      return;
                    }
                    if (decision === "REJECTED" && !comment) {
                      setError("Explain the requested changes before rejecting the package.");
                      event.currentTarget
                        .querySelector<HTMLTextAreaElement>('textarea[name="comment"]')
                        ?.focus();
                      return;
                    }
                    void perform("review", {
                      expectedRevision: value.revision,
                      decision,
                      comment,
                      outputIds: form.getAll("reviewOutput"),
                      confirmTranscript: form.get("confirmTranscript") === "on",
                      confirmTeachingIntegrity: form.get("confirmTeachingIntegrity") === "on",
                    });
                  }}
                >
                  <fieldset disabled={busy}>
                    <h3>{combinedRoles ? "Approval review" : "Content Approver review"}</h3>
                    <fieldset>
                      <legend>Files to review</legend>
                      <p>
                        Select only the files to approve or return for changes. Other files stay
                        unchanged.
                      </p>
                      {value.outputs
                        .filter((o) => studioFileStatus(value, o) === "IN_REVIEW")
                        .map((o) => (
                          <label key={o.id} style={checkStyle}>
                            <input
                              type="checkbox"
                              name="reviewOutput"
                              value={o.id}
                              checked={reviewSelection.includes(o.id)}
                              onChange={(e) =>
                                setReviewSelection(
                                  e.target.checked
                                    ? [...reviewSelection, o.id]
                                    : reviewSelection.filter((id) => id !== o.id),
                                )
                              }
                              style={boxStyle}
                            />
                            {studioChannelLabel(o.channel)} · {o.language} ·{" "}
                            {o.asset?.filename ?? o.title}
                          </label>
                        ))}
                    </fieldset>
                    <label>
                      Review comments — required when requesting changes
                      <textarea name="comment" rows={4} maxLength={4000} />
                    </label>
                    {value.provenance?.transcript.provenance === "MACHINE_TRANSCRIPT" && (
                      <label style={checkStyle}>
                        <input type="checkbox" name="confirmTranscript" style={boxStyle} />I checked
                        the machine transcript against the source and confirm the accuracy of the
                        selected outputs and captions.
                      </label>
                    )}
                    <label style={checkStyle}>
                      <input type="checkbox" name="confirmTeachingIntegrity" style={boxStyle} />I
                      checked source boundaries, context, attribution, captions and translations,
                      and Ashrama branding for every selected output.
                    </label>
                    {detail.reviewAssignment?.blocker && (
                      <output>{detail.reviewAssignment.blocker}</output>
                    )}
                    <div className="actions wrap">
                      <button
                        type="submit"
                        name="decision"
                        value="APPROVED"
                        className="button primary"
                        disabled={
                          !reviewSelection.length ||
                          reviewBlockers.length > 0 ||
                          Boolean(detail.reviewAssignment?.blocker)
                        }
                      >
                        Approve selected files
                      </button>
                      <button type="submit" name="decision" value="REJECTED" className="button">
                        Request changes
                      </button>
                    </div>
                  </fieldset>
                </form>
              </>
            )}
            {studioCanDiscard(value.status, capabilities, "package") &&
              value.outputs.every((o) =>
                studioCanDiscard(studioFileStatus(value, o), capabilities, "package"),
              ) && (
                <button
                  type="button"
                  className="button quiet"
                  style={{ marginTop: 24 }}
                  disabled={busy}
                  onClick={() => setDiscarding("package")}
                >
                  Discard package
                </button>
              )}
            {discarding && (
              <form
                className="confirm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform("discard", {
                    expectedRevision: value.revision,
                    comment: String(new FormData(event.currentTarget).get("comment") ?? ""),
                    ...(discarding === "package" ? {} : { outputId: discarding }),
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <h3>
                    {discarding === "package" ? "Discard this package?" : "Discard this output?"}
                  </h3>
                  <p>
                    The review history is retained. Discarded content is excluded from publication.
                  </p>
                  <label>
                    Reason (optional)
                    <textarea name="comment" rows={2} maxLength={4000} />
                  </label>
                  <div className="actions wrap">
                    <button type="submit" className="button danger">
                      Confirm discard
                    </button>
                    <button type="button" className="button" onClick={() => setDiscarding(null)}>
                      Cancel
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
          </section>
          <StudioHistory packageId={value.id} currentRevision={value.revision} />
          {value.status === "FAILED" &&
            !studioNeedsSuitabilityReview(value.failure) &&
            content &&
            sourcePermissions?.allowed &&
            canCreate && (
              <p className="muted">
                The source permissions are ready. Retrying with the same settings resumes saved work
                and processes only unfinished items. Changing guidance starts new drafts.
              </p>
            )}
          {value.provenance && (
            <details>
              <summary>Source transcript and generation evidence</summary>
              <p>
                Brand: {value.provenance.brandName}. Content engine: {value.provenance.provider} /{" "}
                {value.provenance.model}.
                {value.provenance.draftingProviders?.length ? (
                  <span>
                    {" "}
                    Drafting services used:{" "}
                    {value.provenance.draftingProviders
                      .map((entry) => `${entry.provider} / ${entry.model}`)
                      .join(", ")}
                    .
                  </span>
                ) : null}
                {value.provenance.transcript.recognition && (
                  <>
                    {" "}
                    Transcription: {value.provenance.transcript.recognition.provider} /{" "}
                    {value.provenance.transcript.recognition.model}.
                  </>
                )}
                {value.provenance.inputMode === "transcript_and_audio" &&
                  " Original audio included in content analysis."}
              </p>
              <p>
                {value.provenance.transcript.provenance === "MACHINE_TRANSCRIPT"
                  ? "Machine transcript — a Content Approver must check the source and confirm accuracy before approval."
                  : "Generated from the approved source transcript."}
              </p>
              <div style={{ maxHeight: 360, overflow: "auto", padding: 8 }}>
                {value.provenance.transcript.segments.map((segment) => (
                  <p key={segment.id} style={{ overflowWrap: "anywhere" }}>
                    <strong>
                      {(segment.startMs / 1000).toFixed(1)}–{(segment.endMs / 1000).toFixed(1)}s
                    </strong>{" "}
                    {segment.text}
                  </p>
                ))}
              </div>
              {value.provenance.skippedChannels.length > 0 && (
                <>
                  <h3>Channels not selected</h3>
                  <ul>
                    {value.provenance.skippedChannels.map((channel) => (
                      <li key={channel.channel}>
                        {studioChannelLabel(channel.channel)}: {channel.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
          {value.feedback.length > 0 && (
            <details className="review-discussion" open={value.status === "CHANGES_REQUESTED"}>
              <summary>Review comments ({value.feedback.length})</summary>
              {value.feedback.map((feedback) => (
                <blockquote
                  key={feedback.id}
                  style={{
                    marginInline: 0,
                    borderLeft: "3px solid var(--line)",
                    paddingLeft: 16,
                    overflowWrap: "anywhere",
                  }}
                >
                  <p>
                    <strong>{feedback.action.replaceAll("_", " ")}</strong> ·{" "}
                    {formatTimestamp(feedback.createdAt)}
                  </p>
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    {feedback.comment || "No additional comment."}
                  </p>
                </blockquote>
              ))}
            </details>
          )}
        </>
      )}
      {(value || content) && readiness && (
        <details style={{ marginBlock: 16 }}>
          <summary>Generation and channel readiness</summary>
          <p>Transcription: {readiness.generation.transcription}</p>
          <p>Content generation: {readiness.generation.intelligence}</p>
          <p>
            Translation:{" "}
            {readiness.generation.translation
              ? "Available for selected languages"
              : "Not configured; use the source language"}
          </p>
          {!readiness.generation.available && (
            <p className="notice">
              Generation services need configuration. A queued package will show the specific
              blocker until the service is ready.
            </p>
          )}
          <div className="variant-grid">
            {readiness.channels.map((channel) => (
              <div className="variant-card" key={channel.channel}>
                <strong>{channel.label}</strong>
                <p>
                  {readiness.isTest
                    ? "Test workspace — external posting disabled"
                    : channel.ready
                      ? "Connection configured"
                      : "Connection required"}
                </p>
                <p className="muted">
                  {channel.transport === "unconfigured"
                    ? "No publication connection is configured."
                    : `Delivery: ${channel.transport}`}
                </p>
                {channel.reason && <p>{studioMessage(channel.reason)}</p>}
                {!channel.ready && (
                  <details>
                    <summary>Connection requirements</summary>
                    <p>
                      {readiness.isTest
                        ? "Use a production workspace with an explicitly configured and verified channel account for live posting. This workspace can run a publication test."
                        : "An Admin must configure the Ashrama's verified channel account and its publishing credentials. Credentials are not entered or displayed in this review screen."}
                    </p>
                  </details>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
