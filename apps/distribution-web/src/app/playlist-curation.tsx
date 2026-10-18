"use client";
import {
  DISTRIBUTION_LANGUAGE_NAMES,
  contentRightsSchema,
  studioGenerationRequestSchema,
} from "@satsang/distribution-contracts";
import {
  ONLINE_IMPORT_ERRORS,
  type OnlineImport,
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  studioChannelLabel,
  studioNeedsSuitabilityReview,
} from "@satsang/distribution-domain";
import { type FormEvent, useState } from "react";
import { STUDIO_STATUS_LABELS, studioMessage } from "../lib/studio-model";
import { BundleWorkflow } from "./bundle-workflow";
import { ImportRecovery } from "./import-recovery";

export function PlaylistCuration({
  item,
  items,
  busy,
  send,
  open,
  canCurate = true,
  canReview = false,
  onReview,
  onReload,
  completeOnly = false,
}: {
  item: OnlineImport;
  items: OnlineImport[];
  busy: boolean;
  send: (data: unknown) => Promise<void>;
  open: (id: string) => Promise<void>;
  canCurate?: boolean;
  canReview?: boolean;
  onReview?: () => void;
  onReload?: () => Promise<void>;
  completeOnly?: boolean;
}) {
  const [recordingPage, setRecordingPage] = useState(0);
  const [error, setError] = useState("");
  const [sourceBranding, setSourceBranding] = useState("");
  const [selection, setSelection] = useState("YouTube Shorts, Facebook · English");
  const children = (item.childIds ?? []).flatMap((id) => {
    const child = items.find((value) => value.id === id);
    return child ? [child] : [];
  });
  const ready = children.filter((child) => child.status === "COMPLETE").length;
  const plan = item.curation;
  const members = Object.values(plan?.items ?? {});
  const planned = members.filter((value) => value.packageId).length;
  const approved = members.filter((value) => value.status === "APPROVED").length;
  const generated = members.filter((value) =>
    ["DRAFT", "CHANGES_REQUESTED", "IN_REVIEW", "APPROVED"].includes(value.status ?? ""),
  ).length;
  const awaitingApproval = members.filter((value) => value.status === "IN_REVIEW").length;
  const unsuitable = members.filter((value) => studioNeedsSuitabilityReview(value.error)).length;
  const removedContent =
    Boolean(plan?.pausedForCleanup) || members.some((member) => member.error === "CONTENT_REMOVED");
  const needsRecovery =
    removedContent ||
    children.some((child) => child.status === "FAILED") ||
    members.some(
      (value) =>
        !studioNeedsSuitabilityReview(value.error) && (value.error || value.status === "FAILED"),
    );
  const service = item.serviceIssue ?? children.find((child) => child.serviceIssue)?.serviceIssue;
  const reviewable = generated > 0;
  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const channels = sourceBranding === "bala-swamiji" ? ["youtube"] : form.getAll("channel");
    const rights = contentRightsSchema.safeParse({
      owner: form.get("owner"),
      authorizationBasis: form.get("authorization"),
      territories: ["WORLDWIDE"],
      privacyClass: "PUBLIC",
      channels,
      releaseAt: null,
      expiresAt: null,
    });
    const request = studioGenerationRequestSchema.safeParse({
      languages: form.getAll("language"),
      channels,
      instructions: form.get("instructions"),
      captions: form.get("captions") === "on",
      allCompleteMessages: true,
      ...(sourceBranding === "bala-swamiji"
        ? {
            sourceBranding,
            youtubeClosing: {
              label: "Gurubhavana ADPT",
              url: "https://www.youtube.com/@gurubhavanaadpt",
            },
          }
        : {}),
    });
    if (!rights.success || !request.success) {
      const field = !rights.success
        ? rights.error.issues[0]?.path[0] === "owner"
          ? "owner"
          : rights.error.issues[0]?.path[0] === "authorizationBasis"
            ? "authorization"
            : "channel"
        : !form.getAll("language").length
          ? "language"
          : "channel";
      const input = event.currentTarget.querySelector<HTMLInputElement>(`[name="${field}"]`);
      const section = input?.closest("details");
      if (section) section.open = true;
      input?.focus();
      setError(
        !rights.success
          ? field === "owner"
            ? "Enter the rights holder under Owner and permissions."
            : field === "authorization"
              ? "Enter the authorization under Owner and permissions."
              : "Select at least one channel under Outputs."
          : "Select at least one output language under Outputs.",
      );
      return;
    }
    setError("");
    void send({
      action: "curate-playlist",
      id: item.id,
      rights: rights.data,
      request: request.data,
      confirmed: form.get("confirmed") === "on",
    });
  }
  return (
    <section className="playlist-curation" aria-label="Playlist curation">
      {!completeOnly && <BundleWorkflow item={item} />}
      <p>
        One bundle, one setup. Videos download one at a time; generation can process several
        recordings together, according to the worker's capacity. Generated content stays available
        while the remaining recordings are queued.
      </p>
      {children.length > 20 && (
        <div className="actions wrap">
          <button
            type="button"
            className="button"
            disabled={recordingPage === 0}
            onClick={() => setRecordingPage((p) => p - 1)}
          >
            Previous recordings
          </button>
          <span>
            Recordings {recordingPage * 20 + 1}–
            {Math.min((recordingPage + 1) * 20, children.length)} of {children.length}
          </span>
          <button
            type="button"
            className="button"
            disabled={(recordingPage + 1) * 20 >= children.length}
            onClick={() => setRecordingPage((p) => p + 1)}
          >
            Next recordings
          </button>
        </div>
      )}
      <p>
        <strong>
          {ready} of {children.length} recordings downloaded
        </strong>
      </p>
      {plan && (
        <div className="playlist-overview" aria-label="Playlist progress">
          <progress
            aria-label="Recordings with generated content"
            value={generated}
            max={children.length || 1}
          />
          <dl>
            <div>
              <dt>Content generated</dt>
              <dd>
                {generated} of {children.length}
              </dd>
            </div>
            <div>
              <dt>Sent for approval</dt>
              <dd>{awaitingApproval}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{approved}</dd>
            </div>
            {unsuitable > 0 && (
              <div>
                <dt>No suitable excerpt</dt>
                <dd>{unsuitable}</dd>
              </div>
            )}
          </dl>
          <p>
            {removedContent
              ? "Generated files were removed to free storage. Your masters and shared settings are retained. Generate again only when you need a fresh curation."
              : reviewable
                ? "Open the generated content below. Review each recording in this playlist without returning to the master library."
                : service
                  ? "Downloads are paused. Your playlist permissions and output settings are saved."
                  : "Generation runs automatically for every video using your shared settings. You can leave this page and return to this playlist later."}
          </p>
          {unsuitable > 0 && (
            <p>
              {unsuitable} recording(s) need a source or guidance review. See their explanation
              under Progress below. They are excluded from automatic retries; the other recordings
              continue normally.
            </p>
          )}
        </div>
      )}
      {service && (
        <div className="notice" aria-live="polite">
          <div>
            <strong>
              {service.code === "ONLINE_PROVIDER_VERIFICATION_REQUIRED"
                ? "Playlist paused — verification needed"
                : "Playlist waiting for the video provider"}
            </strong>
            <p>{ONLINE_IMPORT_ERRORS[service.code]}</p>
            {service.retryAt ? (
              <p>The service will retry automatically. You do not need to restart the playlist.</p>
            ) : (
              <p>
                The cloud worker is paused to avoid repeated failures. A successful download from
                the worker is required before access is shown as restored.
              </p>
            )}
          </div>
        </div>
      )}
      {canCurate && onReload && <ImportRecovery item={item} items={items} onSaved={onReload} />}
      {!plan && canCurate ? (
        <form
          onSubmit={start}
          onInvalidCapture={(event) => {
            const section = (event.target as HTMLElement).closest("details");
            if (section) section.open = true;
          }}
          onChange={(event) => {
            const form = new FormData(event.currentTarget);
            setSelection(
              `${
                (form.get("sourceBranding") === "bala-swamiji"
                  ? ["youtube"]
                  : form.getAll("channel")
                )
                  .map((channel) => studioChannelLabel(channel as (typeof STUDIO_CHANNELS)[number]))
                  .join(", ") || "No channel selected"
              } · ${
                form
                  .getAll("language")
                  .map(
                    (language) =>
                      DISTRIBUTION_LANGUAGE_NAMES[
                        language as keyof typeof DISTRIBUTION_LANGUAGE_NAMES
                      ],
                  )
                  .join(", ") || "No output language selected"
              }`,
            );
          }}
        >
          <h3>One setup for the whole bundle</h3>
          <p>
            Confirm the shared owner and permissions, then choose the outputs for all{" "}
            {children.length} videos. Downloads and generation continue automatically, even if you
            leave this page.
          </p>
          <fieldset disabled={busy}>
            <label>
              Speaker and channel branding
              <select
                name="sourceBranding"
                value={sourceBranding}
                onChange={(event) => {
                  setSourceBranding(event.target.value);
                  setSelection(
                    event.target.value === "bala-swamiji"
                      ? "YouTube Shorts · English"
                      : "YouTube Shorts, Facebook · English",
                  );
                }}
              >
                <option value="">Sri Ganapathy Sachchidananda Swamiji · @sgsswamiji</option>
                <option value="bala-swamiji">
                  Sri Bala Swamiji · Gurubhavana ADPT · YouTube Shorts
                </option>
              </select>
            </label>
            {sourceBranding === "bala-swamiji" && (
              <p>
                Every Short credits Sri Datta Vijayananda Teertha Swamiji and ends with “Subscribe
                to Gurubhavana ADPT.”
              </p>
            )}
            <details className="playlist-options">
              <summary>Owner and permissions · Change</summary>
              <div className="fields">
                <label>
                  Rights holder
                  <input
                    name="owner"
                    required
                    maxLength={200}
                    key={sourceBranding}
                    defaultValue={
                      sourceBranding === "bala-swamiji"
                        ? "Gurubhavana ADPT / Avadhoota Datta Peetham"
                        : "Sri Ganapathy Sachchidananda Swamiji / Avadhoota Datta Peetham"
                    }
                  />
                </label>
                <label>
                  Authorization
                  <input
                    name="authorization"
                    required
                    maxLength={2000}
                    defaultValue="Authorized by the content owner to curate and publish this playlist."
                  />
                </label>
              </div>
            </details>
            <details className="playlist-options">
              <summary>Outputs: {selection} · Change</summary>
              <fieldset disabled={sourceBranding === "bala-swamiji"}>
                <legend>Channels</legend>
                <div className="fields">
                  {STUDIO_CHANNELS.map((channel) => (
                    <label className="online-import-checkbox" key={channel}>
                      <input
                        name="channel"
                        value={channel}
                        type="checkbox"
                        key={`${sourceBranding}-${channel}`}
                        defaultChecked={
                          sourceBranding === "bala-swamiji"
                            ? channel === "youtube"
                            : ["youtube", "facebook"].includes(channel)
                        }
                      />
                      {studioChannelLabel(channel)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Output languages</legend>
                <div className="fields">
                  {STUDIO_LANGUAGES.map((language) => (
                    <label className="online-import-checkbox" key={language}>
                      <input
                        name="language"
                        value={language}
                        type="checkbox"
                        defaultChecked={language === "en"}
                      />
                      {DISTRIBUTION_LANGUAGE_NAMES[language]}
                    </label>
                  ))}
                </div>
              </fieldset>{" "}
            </details>

            <label className="online-import-checkbox">
              <input name="captions" type="checkbox" defaultChecked />
              Embed subtitles in the selected languages
            </label>
            <p className="muted">
              English is selected by default. The original speech stays unchanged. Videos use the
              selected speaker's branding and small subtitles below the speaker.
            </p>
            <details className="playlist-options">
              <summary>Message guidance · Change</summary>
              <label>
                Guidance for every video
                <textarea
                  name="instructions"
                  rows={3}
                  maxLength={4000}
                  defaultValue="Find every distinct self-contained, actionable teaching suitable for newcomers. Include the necessary spoken setup and conclusion; do not cut a teaching mid-thought or invent a moral. Preserve the speaker's original continuous voice. Translate faithfully into the selected languages. Use portrait framing while preserving the full head and meaningful gestures. Use source-grounded artwork only when it helps explain the actual passage, and retain source footage when artwork is unnecessary or fails review."
                />
              </label>
            </details>
            <label className="online-import-checkbox">
              <input name="confirmed" type="checkbox" required />I confirm that this owner has
              authorized public, worldwide AI processing and publication on the selected channels
              for every video in this bundle.
            </label>
            <p className="muted">
              Existing curations and their permissions are preserved. New outputs go through AI
              review and then remain subject to human approval before posting.
            </p>
            {error && <p role="alert">{error}</p>}
            <button type="submit" className="button primary">
              {busy
                ? "Starting generation…"
                : `Generate curated content for all ${children.length} videos`}
            </button>
          </fieldset>
        </form>
      ) : plan ? (
        <details className="playlist-options">
          <summary>Shared permissions and output settings</summary>
          <p>
            Shared settings saved:{" "}
            {plan.request.languages
              .map((language) => DISTRIBUTION_LANGUAGE_NAMES[language])
              .join(", ")}{" "}
            · {plan.request.channels.map(studioChannelLabel).join(", ")} ·{" "}
            {plan.request.captions ? "Subtitles on" : "Subtitles off"}. Each downloaded recording
            enters curation automatically. Existing packages keep their original settings.
          </p>
        </details>
      ) : (
        <p>The Content Curator will set up this playlist once before generation.</p>
      )}
      {plan && (
        <p>
          {planned} of {children.length} recordings in curation · {approved} approved
        </p>
      )}
      {reviewable && onReview && (
        <div className="playlist-next-action">
          <p>
            {canReview
              ? "Review the files for each recording, approve or return them with comments, then publish approved content."
              : "Check the generated files, make any corrections, then send each recording's content to the Content Approver."}{" "}
            Approved files stay locked against editing.
          </p>
          <button type="button" className="button primary" disabled={busy} onClick={onReview}>
            Review curated content
          </button>
        </div>
      )}
      {canCurate &&
        plan &&
        service?.code !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED" &&
        (service || needsRecovery) && (
          <button
            type="button"
            className="button"
            disabled={busy || Boolean(service?.retryAt)}
            onClick={() => void send({ action: "resume-playlist", id: item.id })}
          >
            {service
              ? "Retry blocked downloads"
              : removedContent
                ? "Generate again from saved masters"
                : "Retry unfinished videos"}
          </button>
        )}
      <details>
        <summary>Progress for all {children.length} videos</summary>
        <ol className="playlist-progress">
          {children.slice(recordingPage * 20, (recordingPage + 1) * 20).map((child) => {
            const progress = plan?.items[child.id];
            const status = progress?.status;
            const label = child.serviceIssue
              ? "Waiting for import service"
              : child.status === "FAILED"
                ? "Download needs attention"
                : child.status === "DOWNLOADING"
                  ? "Downloading"
                  : child.status === "QUEUED"
                    ? "Waiting to download"
                    : studioNeedsSuitabilityReview(progress?.error)
                      ? "No suitable excerpt found"
                      : progress?.error
                        ? "Curation needs attention"
                        : status
                          ? (STUDIO_STATUS_LABELS[status as keyof typeof STUDIO_STATUS_LABELS] ??
                            status)
                          : plan
                            ? "Waiting for curation"
                            : "Ready for playlist setup";
            return (
              <li key={child.id}>
                <strong>{child.title ?? child.source.id}</strong>
                <p>
                  {label}
                  {progress?.existing ? " · Existing curation preserved" : ""}
                </p>
                {child.error && !service && (
                  <p role="alert">
                    {ONLINE_IMPORT_ERRORS[child.error] ??
                      "Download failed. Use Retry unfinished videos to retry unfinished recordings."}
                  </p>
                )}
                {progress?.error && (
                  <p role={studioNeedsSuitabilityReview(progress.error) ? undefined : "alert"}>
                    {ONLINE_IMPORT_ERRORS[progress.error] ??
                      (progress.error === "PLAYLIST_QUEUE_FAILED"
                        ? "This recording could not enter curation. Use Retry unfinished videos; the other videos will continue."
                        : studioMessage(progress.error))}
                  </p>
                )}
                {child.masterId && !plan && canCurate && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void open(child.masterId as string)}
                  >
                    Open this master
                  </button>
                )}
                {child.masterId && canCurate && studioNeedsSuitabilityReview(progress?.error) && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void open(child.masterId as string)}
                  >
                    Review source and guidance
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
