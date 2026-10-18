"use client";
import { distributionErrorText, distributionText } from "@satsang/distribution-contracts";
import {
  type ContentMaster,
  type DistributionCapability,
  type EditorialReview,
  type RenderRecipe,
  SOCIAL_PLACEMENTS,
  type TranscriptVersion,
} from "@satsang/distribution-domain";
import { type FormEvent, useCallback, useEffect, useState } from "react";

type Job = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STALE";
  recipe: RenderRecipe;
};
type Artifact = {
  artifact: {
    id: string;
    jobId: string;
    revision: number;
    recipeSha256: string;
    approval: EditorialReview | null;
    output: { video: { sha256: string; filename: string }; captions: unknown };
  };
  eligibility: { allowed: boolean; reason?: string };
};
const endpoint = "/distribution/api/renders";
export function VariantsPanel({
  content,
  locale,
  capabilities,
}: { content: ContentMaster; locale: string; capabilities: DistributionCapability[] }) {
  const t = useCallback(
    (key: Parameters<typeof distributionText>[1]) => distributionText(locale, key),
    [locale],
  );
  const [open, setOpen] = useState(false);
  const [nativeBoundary, setNativeBoundary] = useState<{
    transcriptId: string;
    startMs: number;
    endMs: number;
  } | null>(null);
  useEffect(() => {
    const selected = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.masterId === content.id) {
        setNativeBoundary(detail);
        setOpen(true);
      }
    };
    window.addEventListener("distribution:native-boundary", selected);
    return () => window.removeEventListener("distribution:native-boundary", selected);
  }, [content.id]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [renderResponse, editorialResponse] = await Promise.all([
        fetch(`${endpoint}?masterId=${content.id}`, { cache: "no-store" }),
        fetch(`/distribution/api/editorial/${content.id}`, { cache: "no-store" }),
      ]);
      if (!renderResponse.ok || !editorialResponse.ok) throw new Error("UNAVAILABLE");
      const data = await renderResponse.json();
      setJobs(data.jobs);
      setArtifacts(data.artifacts);
      setTranscripts(
        (await editorialResponse.json()).transcripts.filter(
          (item: TranscriptVersion) =>
            item.masterVersionId === content.currentVersion.id &&
            item.review?.decision === "APPROVED" &&
            item.review.revision === item.revision,
        ),
      );
    } catch {
      setError(t("error"));
    }
  }, [content.id, content.currentVersion.id, t]);
  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [open, load]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          masterId: content.id,
          expectedSourceRevision: content.revision,
          transcriptVersionId: data.get("transcript"),
          quoteId: null,
          translationId: null,
          template: {
            id: nativeBoundary ? "contained-teaching-v1" : "contained-preview-v1",
            version: 1,
          },
          aspect: data.get("aspect"),
          language: content.language,
          startMs: Math.round(Number(data.get("start")) * 1000),
          endMs: Math.round(Number(data.get("end")) * 1000),
          captionMode: data.get("captions"),
          channel: "manual_export",
          ...(data.get("placement") ? { placement: data.get("placement") } : {}),
          territory: data.get("territory"),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await load();
    } catch (error) {
      setError(
        distributionErrorText(locale, error instanceof Error ? error.message : "UNAVAILABLE"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function review(item: Artifact, decision: "APPROVED" | "REJECTED") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}/${item.artifact.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: item.artifact.revision,
          expectedRecipeSha256: item.artifact.recipeSha256,
          expectedAssetSha256: item.artifact.output.video.sha256,
          decision,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      await load();
    } catch (error) {
      setError(
        distributionErrorText(locale, error instanceof Error ? error.message : "UNAVAILABLE"),
      );
    } finally {
      setBusy(false);
    }
  }
  if (content.currentVersion.mimeType !== "video/mp4" || content.state === "WITHDRAWN") return null;
  return (
    <details
      className="panel editor-details"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("variants")}</summary>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {content.state === "APPROVED" &&
      capabilities.includes("content.create") &&
      transcripts.length > 0 ? (
        <form onSubmit={create} key={nativeBoundary ? JSON.stringify(nativeBoundary) : "standard"}>
          <fieldset disabled={busy}>
            <div className="fields">
              <label>
                Destination platform
                <select name="placement" defaultValue="">
                  <option value="">Unassigned / manual export</option>
                  {SOCIAL_PLACEMENTS.map((placement) => (
                    <option value={placement} key={placement}>
                      {placement.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("selectTranscript")}
                <select name="transcript" defaultValue={nativeBoundary?.transcriptId}>
                  {transcripts.map((item) => (
                    <option value={item.id} key={item.id}>
                      {t("version")} {item.revision} · {item.language}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("aspect")}
                <select name="aspect">
                  {["16:9", "9:16", "4:5", "1:1"].map((value) => (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fields">
              <label>
                {t("startSeconds")}
                <input
                  type="number"
                  name="start"
                  min="0"
                  step="0.001"
                  defaultValue={nativeBoundary ? nativeBoundary.startMs / 1000 : 0}
                  required
                />
              </label>
              <label>
                {t("endSeconds")}
                <input
                  type="number"
                  name="end"
                  min="0.001"
                  step="0.001"
                  max="86400"
                  defaultValue={nativeBoundary ? nativeBoundary.endMs / 1000 : undefined}
                  required
                />
              </label>
            </div>
            <div className="fields">
              <label>
                {t("captions")}
                <select name="captions">
                  <option value="approved_transcript">{t("transcripts")}</option>
                  <option value="none">{t("noCaptions")}</option>
                </select>
              </label>
              <label>
                {t("territories")}
                <input
                  name="territory"
                  pattern="[A-Z]{2}"
                  minLength={2}
                  maxLength={2}
                  placeholder="IN"
                  required
                />
              </label>
            </div>
            <button type="submit" className="button primary">
              {busy ? t("loading") : t("createVariant")}
            </button>
          </fieldset>
        </form>
      ) : (
        <p className="muted">{t("pendingReview")}</p>
      )}
      {!jobs.length && <p className="muted">{t("emptyVariants")}</p>}
      <div className="variant-grid">
        {jobs.map((job) => {
          const item = artifacts.find((value) => value.artifact.jobId === job.id);
          const allowedPreview =
            item &&
            (item.eligibility.allowed || item.eligibility.reason === "ARTIFACT_NOT_APPROVED");
          return (
            <section className="variant-card" key={job.id}>
              <div className="preview-meta">
                <strong>{job.recipe.aspect}</strong>
                <span className="badge">
                  {item && !allowedPreview
                    ? t("STALE")
                    : item?.artifact.approval?.decision
                      ? t(item.artifact.approval.decision)
                      : t(job.status)}
                </span>
              </div>
              <p className="muted">
                Intended channel: {job.recipe.placement?.replaceAll("_", " ") ?? "Unassigned"}
              </p>
              {item && <p className="filename">{item.artifact.output.video.filename}</p>}
              {allowedPreview && (
                // biome-ignore lint/a11y/useMediaCaption: The reviewed recipe can burn captions into the picture; an available sidecar is attached below.
                <video controls playsInline src={`${endpoint}/${item.artifact.id}/media`}>
                  {Boolean(item.artifact.output.captions) && (
                    <track
                      kind="captions"
                      src={`${endpoint}/${item.artifact.id}/captions`}
                      srcLang={job.recipe.language}
                      label={t("captions")}
                      default
                    />
                  )}
                </video>
              )}
              {item && !allowedPreview && <p className="muted">{t("sourceChanged")}</p>}
              <div className="actions wrap">
                {item && allowedPreview && capabilities.includes("content.review") && (
                  <>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => void review(item, "APPROVED")}
                    >
                      {t("approve")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => void review(item, "REJECTED")}
                    >
                      {t("reject")}
                    </button>
                  </>
                )}
                {item?.eligibility.allowed && capabilities.includes("content.publish") && (
                  <a href={`${endpoint}/${item.artifact.id}/export`} className="button" download>
                    {t("manualExport")}
                  </a>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </details>
  );
}
