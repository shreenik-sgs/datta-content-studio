"use client";
import { nativeAnalysisSchema } from "@satsang/distribution-contracts";
import {
  type ContentMaster,
  type DistributionCapability,
  INTEGRITY_CHECKS,
  NATIVE_LANGUAGES,
  type NativeAnalysis,
  type NativeReview,
  type TranscriptVersion,
  teachingIntegrity,
} from "@satsang/distribution-domain";
import { useCallback, useEffect, useRef, useState } from "react";
const style = {
  minHeight: 44,
  padding: "10px 14px",
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--surface)",
  color: "var(--ink)",
  font: "inherit",
};
type Data = {
  analyses: {
    id: string;
    analysis: NativeAnalysis;
  }[];
  reviews: {
    analysis_id: string;
    candidate_id: string;
    review: NativeReview;
  }[];
  reviewerLanguages: string[];
  flags: Record<string, boolean>;
};
export function NativePanel({
  content,
  capabilities,
}: {
  content: ContentMaster;
  capabilities: readonly DistributionCapability[];
}) {
  const [data, setData] = useState<Data | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptVersion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<
    Record<
      string,
      {
        first: string;
        last: string;
      }
    >
  >({});
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const player = useRef<HTMLVideoElement | null>(null);
  const stop = useRef(0);
  const pendingCommand = useRef<{ signature: string; requestId: string } | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/distribution/api/native/${content.id}`, { cache: "no-store" });
    if (response.status === 404) {
      setData(null);
      return;
    }
    if (!response.ok) throw new Error("Review is temporarily unavailable.");
    setData(await response.json());
    const editorial = await fetch(`/distribution/api/editorial/${content.id}`, {
      cache: "no-store",
    });
    if (editorial.ok) setTranscripts((await editorial.json()).transcripts);
  }, [content.id]);
  useEffect(() => {
    setData(null);
    void load().catch(() => {});
  }, [load]);
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const signature = JSON.stringify(body);
      if (pendingCommand.current?.signature !== signature)
        pendingCommand.current = { signature, requestId: crypto.randomUUID() };
      const response = await fetch(`/distribution/api/native/${content.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, requestId: pendingCommand.current.requestId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Review is unavailable.");
      await load();
      pendingCommand.current = null;
      setReason("");
      setEvidence({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  if (!data || !NATIVE_LANGUAGES.includes(content.language as "te" | "kn" | "ta")) return null;
  const analysisRow = data.analyses.find((a) => a.id === selected) ?? data.analyses[0];
  const analysis = analysisRow?.analysis;
  const transcript = transcripts.find((t) => t.id === analysis?.transcriptVersionId);
  return (
    <details
      style={{ marginTop: 24, borderTop: "1px solid var(--line)", paddingTop: 18 }}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary style={{ minHeight: 44, cursor: "pointer", fontSize: 18, fontWeight: 600 }}>
        Original-language teaching review — optional
      </summary>
      <p>
        This specialist tool checks teaching excerpts against the original-language transcript.
        English explanations here help reviewers understand the meaning; they are not approved
        subtitles or quotations. For generated English subtitles, use the output-language options in
        the curation workflow.
      </p>
      {error && <p role="alert">{error.replaceAll("_", " ")}</p>}
      {capabilities.includes("content.create") && data.flags.native_clip_candidates && (
        <label style={{ display: "grid", gap: 8, marginBlock: 16 }}>
          Import a prepared teaching-review file (JSON)
          <input
            style={style}
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 1024 * 1024) {
                setError("The analysis file is too large.");
                return;
              }
              try {
                const proposal = nativeAnalysisSchema.parse(JSON.parse(await file.text()));
                await send({
                  action: "propose",
                  analysis: proposal,
                });
              } catch {
                setError("Use a valid source-linked native analysis file.");
              }
              e.target.value = "";
            }}
          />
          <small>
            Upload an analysis file prepared separately and linked to this recording. A reviewer
            must check it against the original language. Uploading this file does not generate new
            AI content.
          </small>
        </label>
      )}
      {!analysis ? (
        <p>
          No teaching-review file has been imported. You can skip this tool for normal curation.
        </p>
      ) : (
        <>
          <output style={{ display: "block", marginBlock: 16 }}>
            {
              analysis.candidates.filter(
                (c) =>
                  !data.reviews.some(
                    (r) =>
                      r.analysis_id === analysisRow?.id &&
                      r.candidate_id === c.id &&
                      r.review.decision === "APPROVED",
                  ),
              ).length
            }{" "}
            candidates awaiting approval ·{" "}
            {
              analysis.annotations.filter((a) => a.confidence < 0.85 || a.uncertainty.length > 0)
                .length
            }{" "}
            source segments require wording review.
          </output>
          <label style={{ display: "grid", gap: 6 }}>
            Analysis version
            <select
              style={style}
              value={requiredValue(analysisRow).id}
              onChange={(e) => {
                setSelected(e.target.value);
                setEvidence({});
                setReason("");
              }}
            >
              {data.analyses.map((a, i) => (
                <option key={a.id} value={a.id}>
                  {a.analysis.language.toUpperCase()} · {a.analysis.provenance.model} ·{" "}
                  {data.analyses.length - i}
                </option>
              ))}
            </select>
          </label>
          {/* Source text is shown beside the player; captions are generated only from separately approved transcripts. */}
          {/* biome-ignore lint/a11y/useMediaCaption: The synchronized authoritative transcript is the adjacent review surface. */}
          <video
            ref={player}
            controls
            preload="none"
            aria-label="Original source context"
            src={`/distribution/api/content/${content.id}/media`}
            style={{ width: "100%", maxHeight: 400, marginTop: 16, background: "#111" }}
            onTimeUpdate={() => {
              if (player.current && stop.current && player.current.currentTime >= stop.current) {
                player.current.pause();
                stop.current = 0;
              }
            }}
          />
          <details>
            <summary style={{ minHeight: 44 }}>Teaching segments</summary>
            {analysis.teachings.map((teaching) => (
              <article key={teaching.id} style={{ padding: 12 }}>
                <strong>{teaching.kind}</strong>
                <p lang={analysis.language}>{teaching.nativeSummary}</p>
                {data.flags.native_semantic_shadow && teaching.englishShadow && (
                  <p>English review aid: {teaching.englishShadow}</p>
                )}
                <small>
                  {teaching.segmentIds
                    .map((id) => {
                      const segment = transcript?.segments.find((s) => s.id === id);
                      return segment
                        ? `${(segment.startMs / 1000).toFixed(1)}–${(segment.endMs / 1000).toFixed(1)}s`
                        : id;
                    })
                    .join(" · ")}
                </small>
              </article>
            ))}
          </details>
          {analysis.candidates.map((candidate) => {
            const review = data.reviews.find(
              (r) =>
                r.analysis_id === requiredValue(analysisRow).id && r.candidate_id === candidate.id,
            )?.review;
            const checks = teachingIntegrity(analysis, candidate);
            return (
              <article
                key={candidate.id}
                style={{
                  marginTop: 20,
                  padding: 16,
                  border: "1px solid var(--line)",
                  borderRadius: 16,
                }}
              >
                <h3>
                  Candidate · {(candidate.startMs / 1000).toFixed(1)}–
                  {(candidate.endMs / 1000).toFixed(1)} seconds
                </h3>
                <p>{candidate.rationale}</p>
                <button
                  type="button"
                  style={style}
                  onClick={() => {
                    if (player.current) {
                      player.current.currentTime = Math.max(0, candidate.startMs / 1000 - 20);
                      stop.current = Math.min(
                        (transcript?.durationMs ?? candidate.endMs + 20000) / 1000,
                        candidate.endMs / 1000 + 20,
                      );
                      void player.current
                        .play()
                        .catch(() => setError("Source playback is unavailable."));
                    }
                  }}
                >
                  Play with 20 seconds of context
                </button>
                {candidate.segmentIds.map((id) => {
                  const text = transcript?.segments.find((s) => s.id === id);
                  const annotation = analysis.annotations.find((a) => a.segmentId === id);
                  return (
                    <div
                      key={id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))",
                        gap: 16,
                        marginBlock: 14,
                      }}
                    >
                      <div>
                        <strong>{annotation?.speakerName}</strong>
                        <p lang={analysis.language}>
                          {text?.displayText ?? "Source transcript unavailable"}
                        </p>
                        <small>
                          {annotation?.languageSpans
                            .map((s) => s.language.toUpperCase())
                            .join(" · ")}{" "}
                          · {Math.round((annotation?.confidence ?? 0) * 100)}% recognition
                          confidence
                        </small>
                        {annotation?.uncertainty.map((u) => (
                          <p key={u} role="note">
                            {u}
                          </p>
                        ))}
                      </div>
                      {data.flags.native_semantic_shadow && (
                        <div>
                          <strong>English semantic shadow · review aid</strong>
                          <p>{annotation?.englishShadow ?? "Not recorded"}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
                {capabilities.includes("content.create") &&
                  data.flags.native_clip_candidates &&
                  transcript && (
                    <details>
                      <summary style={{ minHeight: 44 }}>
                        Adjust boundaries and request a new review
                      </summary>
                      <p>
                        Keep the complete teaching. Text corrections belong in Transcript Review and
                        create a new authoritative version.
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                        {(["first", "last"] as const).map((edge) => (
                          <label key={edge}>
                            {edge === "first" ? "Beginning" : "End"}
                            <select
                              style={style}
                              value={
                                range[candidate.id]?.[edge] ??
                                (edge === "first"
                                  ? candidate.segmentIds[0]
                                  : candidate.segmentIds.at(-1))
                              }
                              onChange={(e) =>
                                setRange({
                                  ...range,
                                  [candidate.id]: {
                                    first:
                                      range[candidate.id]?.first ??
                                      requiredValue(candidate.segmentIds[0]),
                                    last:
                                      range[candidate.id]?.last ??
                                      requiredValue(candidate.segmentIds.at(-1)),
                                    [edge]: e.target.value,
                                  },
                                })
                              }
                            >
                              {transcript.segments.map((segment) => (
                                <option key={segment.id} value={segment.id}>
                                  {(segment.startMs / 1000).toFixed(1)}s ·{" "}
                                  {segment.displayText.slice(0, 70)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        style={style}
                        disabled={busy}
                        onClick={() => {
                          const first = transcript.segments.findIndex(
                            (s) => s.id === (range[candidate.id]?.first ?? candidate.segmentIds[0]),
                          );
                          const last = transcript.segments.findIndex(
                            (s) =>
                              s.id === (range[candidate.id]?.last ?? candidate.segmentIds.at(-1)),
                          );
                          if (first < 0 || last < first) {
                            setError("Choose an ordered source range.");
                            return;
                          }
                          const selectedSegments = transcript.segments.slice(first, last + 1);
                          const segmentIds = selectedSegments.map((s) => s.id);
                          void send({
                            action: "propose",
                            analysis: {
                              ...analysis,
                              candidates: analysis.candidates.map((c) =>
                                c.id === candidate.id
                                  ? {
                                      ...c,
                                      segmentIds,
                                      startMs: requiredValue(selectedSegments[0]).startMs,
                                      endMs: requiredValue(selectedSegments.at(-1)).endMs,
                                      rationale:
                                        "Boundary adjusted by the editor; all integrity checks require a new native review.",
                                      checks: INTEGRITY_CHECKS.map((check) => ({
                                        check,
                                        status: "REVIEW",
                                        evidence:
                                          "The editor changed these boundaries. Review the complete source context.",
                                        segmentIds,
                                      })),
                                    }
                                  : c,
                              ),
                            },
                          });
                        }}
                      >
                        Save new boundary proposal
                      </button>
                    </details>
                  )}
                <details>
                  <summary style={{ minHeight: 44 }}>Separate candidate scores</summary>
                  <dl>
                    {Object.entries(candidate.scores).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key.replace(/[A-Z]/g, (l) => ` ${l.toLowerCase()}`)}</dt>
                        <dd>{Math.round(value * 100)}%</dd>
                      </div>
                    ))}
                  </dl>
                </details>
                <h4>Teaching integrity</h4>
                <ul style={{ paddingLeft: 20 }}>
                  {checks.map((check) => (
                    <li key={check.check} style={{ marginBottom: 12 }}>
                      <strong>
                        {check.check.replaceAll("_", " ")} · {check.status}
                      </strong>
                      <p>{check.evidence}</p>
                      {data.flags.native_language_review &&
                        data.reviewerLanguages.includes(analysis.language) && (
                          <label style={{ display: "grid", gap: 6 }}>
                            Reviewer evidence
                            <textarea
                              style={{ ...style, width: "100%", boxSizing: "border-box" }}
                              aria-label={`${check.check.replaceAll("_", " ")} review evidence`}
                              value={evidence[`${candidate.id}:${check.check}`] ?? ""}
                              onChange={(e) =>
                                setEvidence({
                                  ...evidence,
                                  [`${candidate.id}:${check.check}`]: e.target.value,
                                })
                              }
                              maxLength={4000}
                            />
                          </label>
                        )}
                    </li>
                  ))}
                </ul>
                {capabilities.includes("content.create") && review?.decision === "APPROVED" && (
                  <button
                    type="button"
                    style={style}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("distribution:native-boundary", {
                          detail: {
                            masterId: content.id,
                            transcriptId: analysis.transcriptVersionId,
                            startMs: candidate.startMs,
                            endMs: candidate.endMs,
                          },
                        }),
                      )
                    }
                  >
                    Open approved boundaries in Variant Studio
                  </button>
                )}
                {review && (
                  <p>
                    Recorded decision: {review.decision.toLowerCase()} · {review.reason}. Current
                    source and reviewer eligibility are rechecked when rendering.
                  </p>
                )}
                {capabilities.includes("content.review") &&
                data.flags.native_language_review &&
                data.reviewerLanguages.includes(analysis.language) ? (
                  <div>
                    <label style={{ display: "grid", gap: 6 }}>
                      Decision reason
                      <textarea
                        style={style}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={4000}
                      />
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
                      {(["APPROVED", "REJECTED"] as const).map((decision) => (
                        <button
                          type="button"
                          style={style}
                          key={decision}
                          disabled={
                            busy ||
                            !reason.trim() ||
                            INTEGRITY_CHECKS.some(
                              (c) => !evidence[`${candidate.id}:${c}`]?.trim(),
                            ) ||
                            (decision === "APPROVED" && checks.some((c) => c.status === "FAIL"))
                          }
                          onClick={() =>
                            void send({
                              action: "review",
                              analysisId: requiredValue(analysisRow).id,
                              candidateId: candidate.id,
                              expectedRevision: review?.revision ?? 0,
                              decision,
                              reason,
                              checks: INTEGRITY_CHECKS.map((check) => ({
                                check,
                                evidence: evidence[`${candidate.id}:${check}`] ?? "",
                              })),
                            })
                          }
                        >
                          {decision === "APPROVED"
                            ? "Approve native boundaries"
                            : "Reject candidate"}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p>
                    A designated reviewer for this source language must review these boundaries.
                  </p>
                )}
              </article>
            );
          })}
        </>
      )}
    </details>
  );
}

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}
