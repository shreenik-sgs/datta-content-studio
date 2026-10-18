"use client";

import {
  type DistributionTextKey,
  distributionErrorText,
  distributionText,
} from "@satsang/distribution-contracts";
import {
  type ContentMaster,
  type DistributionCapability,
  type EffectiveQuoteDecision,
  type GlossaryEntry,
  type QuoteCandidate,
  type TranscriptVersion,
  sourceContextWindow,
} from "@satsang/distribution-domain";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

type DraftSegment = { id: string; start: string; end: string; text: string };
type EditorialData = {
  transcripts: TranscriptVersion[];
  quotes: QuoteCandidate[];
  glossary: GlossaryEntry[];
  quoteEligibility: Record<string, EffectiveQuoteDecision>;
};
const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  minHeight: 44,
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: 12,
  color: "var(--ink)",
  background: "white",
  font: "inherit",
};
const fieldStyle: CSSProperties = { display: "grid", gap: 6, minWidth: 0, fontSize: 14 };
const buttonStyle: CSSProperties = {
  minHeight: 44,
  padding: "9px 16px",
  border: "1px solid var(--line)",
  borderRadius: 999,
  background: "white",
  color: "var(--kamala-deep)",
  font: "inherit",
  cursor: "pointer",
};
const primaryStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--kamala)",
  color: "white",
  borderColor: "var(--kamala)",
};
const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
};
const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,160px),1fr))",
  gap: 12,
};
const panelStyle: CSSProperties = {
  borderTop: "1px solid var(--line)",
  marginTop: 22,
  paddingTop: 18,
  display: "grid",
  gap: 16,
  minWidth: 0,
};

export function EditorialPanel({
  content,
  locale,
  capabilities,
}: { content: ContentMaster; locale: string; capabilities: DistributionCapability[] }) {
  const t = useCallback((key: DistributionTextKey) => distributionText(locale, key), [locale]);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<EditorialData>({
    transcripts: [],
    quotes: [],
    glossary: [],
    quoteEligibility: {},
  });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [duration, setDuration] = useState("");
  const [draft, setDraft] = useState<DraftSegment[]>([
    { id: "segment-1", start: "0", end: "", text: "" },
  ]);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [firstSegment, setFirstSegment] = useState(0);
  const [lastSegment, setLastSegment] = useState(0);
  const [term, setTerm] = useState("");
  const [preferred, setPreferred] = useState("");
  const player = useRef<HTMLMediaElement | null>(null);
  const stopAt = useRef<number | null>(null);
  const canCreate = capabilities.includes("content.create");
  const canReview = capabilities.includes("content.review");
  const active = content.state !== "WITHDRAWN";
  const hasMedia =
    content.currentVersion.mimeType.startsWith("audio/") ||
    content.currentVersion.mimeType.startsWith("video/");
  const selected =
    data.transcripts.find((item) => item.id === selectedId) ??
    data.transcripts.find((item) => item.masterVersionId === content.currentVersion.id) ??
    data.transcripts[0];
  const current =
    selected?.masterVersionId === content.currentVersion.id &&
    !data.transcripts.some((item) => item.parentVersionId === selected.id);
  const selectedSegments = selected?.segments.slice(firstSegment, lastSegment + 1) ?? [];
  const selectedText = selectedSegments.map((segment) => segment.displayText).join(" ");
  const load = useCallback(async () => {
    const response = await fetch(`/distribution/api/editorial/${content.id}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "unavailable");
    setData(payload);
    setLoaded(true);
  }, [content.id]);
  useEffect(() => {
    if (!open || !hasMedia) return;
    let cancelled = false;
    setError("");
    load().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [open, hasMedia, load]);
  const selectionKey = selected?.id ?? "";
  useEffect(() => {
    if (!selectionKey) return;
    setCorrections({});
    setFirstSegment(0);
    setLastSegment(0);
  }, [selectionKey]);
  async function perform(id: string, action: string, body: unknown) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(`/distribution/api/editorial/${id}/${action}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "unavailable");
      await load();
      if (result.transcript?.id) setSelectedId(result.transcript.id);
      setCorrections({});
      setSaved(true);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "unavailable");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function playContext(startMs: number, endMs: number, durationMs: number) {
    if (!player.current) return;
    try {
      const span = sourceContextWindow({ startMs, endMs, durationMs, contextMs: 20000 });
      player.current.currentTime = span.startMs / 1000;
      stopAt.current = span.endMs / 1000;
      player.current.play().catch(() => setError("unavailable"));
    } catch {
      setError("INVALID_SOURCE_SPAN");
    }
  }
  const onTimeUpdate = () => {
    if (player.current && stopAt.current !== null && player.current.currentTime >= stopAt.current) {
      player.current.pause();
      stopAt.current = null;
    }
  };
  const onLoadedMetadata = () => {
    if (player.current && Number.isFinite(player.current.duration))
      setDuration(String(Math.ceil(player.current.duration * 1000) / 1000));
  };
  if (!hasMedia) return null;
  return (
    <details style={panelStyle} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        style={{
          color: "var(--kamala-deep)",
          fontSize: 18,
          fontWeight: 650,
          cursor: "pointer",
          minHeight: 44,
        }}
      >
        {t("editorial")}
      </summary>
      {open && (
        <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
          {error && (
            <div role="alert" style={{ color: "var(--kamala-deep)" }}>
              {distributionErrorText(locale, error)}{" "}
              <button
                type="button"
                style={buttonStyle}
                onClick={() => load().catch(() => setError("unavailable"))}
              >
                {t("retry")}
              </button>
            </div>
          )}
          {saved && <output>{t("saved")}</output>}
          {!loaded ? (
            <output>{t("loading")}</output>
          ) : (
            <>
              {content.currentVersion.mimeType.startsWith("video/") ? (
                <video
                  ref={(element) => {
                    player.current = element;
                  }}
                  aria-label={t("contentPreview")}
                  controls
                  preload="metadata"
                  style={{ width: "100%", maxHeight: 320, borderRadius: 16 }}
                  src={`/distribution/api/content/${content.id}/media`}
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={onTimeUpdate}
                >
                  <track kind="captions" />
                </video>
              ) : (
                <audio
                  ref={(element) => {
                    player.current = element;
                  }}
                  aria-label={t("contentPreview")}
                  controls
                  preload="metadata"
                  style={{ width: "100%" }}
                  src={`/distribution/api/content/${content.id}/media`}
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={onTimeUpdate}
                >
                  <track kind="captions" />
                </audio>
              )}
              <section
                style={{ display: "grid", gap: 16, minWidth: 0 }}
                aria-label={t("transcripts")}
              >
                <h3 style={{ margin: 0, color: "var(--kamala-deep)" }}>{t("transcripts")}</h3>
                {!selected ||
                !data.transcripts.some(
                  (item) => item.masterVersionId === content.currentVersion.id,
                ) ? (
                  <>
                    <p>{t("emptyTranscripts")}</p>
                    {canCreate && active && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void perform(content.id, "transcript", {
                            expectedSourceVersionId: content.currentVersion.id,
                            language: content.language,
                            durationMs: Math.round(Number(duration) * 1000),
                            segments: draft.map((segment) => ({
                              id: segment.id,
                              startMs: Math.round(Number(segment.start) * 1000),
                              endMs: Math.round(Number(segment.end) * 1000),
                              originalText: segment.text,
                              displayText: segment.text,
                            })),
                          });
                        }}
                        style={{ display: "grid", gap: 16 }}
                      >
                        <label style={fieldStyle}>
                          {t("sourceDurationSeconds")}
                          <input
                            style={inputStyle}
                            type="number"
                            min="0.001"
                            step="0.001"
                            required
                            value={duration}
                            onChange={(event) => setDuration(event.target.value)}
                          />
                        </label>
                        {draft.map((segment, index) => (
                          <fieldset
                            key={segment.id}
                            style={{
                              border: "1px solid var(--line)",
                              borderRadius: 16,
                              padding: 14,
                              display: "grid",
                              gap: 12,
                              minWidth: 0,
                            }}
                          >
                            <legend>{index + 1}</legend>
                            <div style={gridStyle}>
                              <label style={fieldStyle}>
                                {t("startSeconds")}
                                <input
                                  style={inputStyle}
                                  type="number"
                                  min="0"
                                  step="0.001"
                                  required
                                  value={segment.start}
                                  onChange={(event) =>
                                    setDraft((rows) =>
                                      rows.map((row) =>
                                        row.id === segment.id
                                          ? { ...row, start: event.target.value }
                                          : row,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label style={fieldStyle}>
                                {t("endSeconds")}
                                <input
                                  style={inputStyle}
                                  type="number"
                                  min="0.001"
                                  step="0.001"
                                  required
                                  value={segment.end}
                                  onChange={(event) =>
                                    setDraft((rows) =>
                                      rows.map((row) =>
                                        row.id === segment.id
                                          ? { ...row, end: event.target.value }
                                          : row,
                                      ),
                                    )
                                  }
                                />
                              </label>
                            </div>
                            <label style={fieldStyle}>
                              {t("transcriptText")}
                              <textarea
                                style={{ ...inputStyle, minHeight: 90 }}
                                maxLength={4000}
                                required
                                value={segment.text}
                                onChange={(event) =>
                                  setDraft((rows) =>
                                    rows.map((row) =>
                                      row.id === segment.id
                                        ? { ...row, text: event.target.value }
                                        : row,
                                    ),
                                  )
                                }
                              />
                            </label>
                            {draft.length > 1 && (
                              <button
                                type="button"
                                style={buttonStyle}
                                disabled={busy}
                                onClick={() =>
                                  setDraft((rows) => rows.filter((row) => row.id !== segment.id))
                                }
                              >
                                {t("removeSegment")}
                              </button>
                            )}
                          </fieldset>
                        ))}
                        <div style={rowStyle}>
                          <button
                            type="button"
                            style={buttonStyle}
                            disabled={busy || draft.length >= 1000}
                            onClick={() =>
                              setDraft((rows) => [
                                ...rows,
                                {
                                  id: crypto.randomUUID(),
                                  start: rows.at(-1)?.end ?? "0",
                                  end: "",
                                  text: "",
                                },
                              ])
                            }
                          >
                            {t("addSegment")}
                          </button>
                          <button style={primaryStyle} type="submit" disabled={busy}>
                            {t("saveTranscript")}
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                ) : (
                  <>
                    <label style={fieldStyle}>
                      {t("selectTranscript")}
                      <select
                        style={inputStyle}
                        value={selected.id}
                        onChange={(event) => setSelectedId(event.target.value)}
                      >
                        {data.transcripts.map((item) => (
                          <option key={item.id} value={item.id}>
                            {t("version")} {item.number} · {item.language} ·{" "}
                            {item.review
                              ? t(item.review.decision === "APPROVED" ? "APPROVED" : "REJECTED")
                              : t("pendingReview")}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!current && <output>{t("sourceChanged")}</output>}
                    {selected.segments.map((segment, index) => (
                      <div
                        key={segment.id}
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 16,
                          padding: 14,
                          display: "grid",
                          gap: 10,
                          minWidth: 0,
                        }}
                      >
                        <div style={{ ...rowStyle, justifyContent: "space-between" }}>
                          <span>
                            {index + 1} · {(segment.startMs / 1000).toFixed(1)}–
                            {(segment.endMs / 1000).toFixed(1)}
                          </span>
                          {current && (
                            <button
                              type="button"
                              style={buttonStyle}
                              onClick={() =>
                                playContext(segment.startMs, segment.endMs, selected.durationMs)
                              }
                            >
                              {t("playContext")}
                            </button>
                          )}
                        </div>
                        <details>
                          <summary style={{ minHeight: 44, cursor: "pointer" }}>
                            {t("originalText")}
                          </summary>
                          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {segment.originalText}
                          </p>
                        </details>
                        <label style={fieldStyle}>
                          {t("correctedText")}
                          <textarea
                            style={{ ...inputStyle, minHeight: 90 }}
                            maxLength={4000}
                            value={corrections[segment.id] ?? segment.displayText}
                            disabled={!canCreate || !current || !active || busy}
                            onChange={(event) =>
                              setCorrections((value) => ({
                                ...value,
                                [segment.id]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                    ))}
                    <div style={rowStyle}>
                      {canCreate && current && active && (
                        <button
                          type="button"
                          style={buttonStyle}
                          disabled={busy || Object.keys(corrections).length === 0}
                          onClick={() =>
                            void perform(selected.id, "correct", {
                              expectedRevision: selected.revision,
                              corrections: Object.entries(corrections).map(
                                ([segmentId, displayText]) => ({ segmentId, displayText }),
                              ),
                            })
                          }
                        >
                          {t("saveCorrections")}
                        </button>
                      )}
                      {canReview && current && active && (
                        <>
                          <button
                            type="button"
                            style={primaryStyle}
                            disabled={busy || Object.keys(corrections).length > 0}
                            onClick={() =>
                              void perform(selected.id, "review", {
                                expectedRevision: selected.revision,
                                decision: "APPROVED",
                              })
                            }
                          >
                            {t("approve")}
                          </button>
                          <button
                            type="button"
                            style={buttonStyle}
                            disabled={busy || Object.keys(corrections).length > 0}
                            onClick={() =>
                              void perform(selected.id, "review", {
                                expectedRevision: selected.revision,
                                decision: "REJECTED",
                              })
                            }
                          >
                            {t("reject")}
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </section>
              <section style={panelStyle} aria-label={t("quotes")}>
                <h3 style={{ margin: 0, color: "var(--kamala-deep)" }}>{t("quotes")}</h3>
                {selected &&
                  current &&
                  selected.review?.decision === "APPROVED" &&
                  canCreate &&
                  active && (
                    <form
                      style={{ display: "grid", gap: 14 }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const first = selectedSegments[0];
                        const last = selectedSegments.at(-1);
                        if (first && last)
                          void perform(selected.id, "quote", {
                            transcriptVersionId: selected.id,
                            transcriptRevision: selected.revision,
                            kind: "EXACT_QUOTE",
                            segmentIds: selectedSegments.map((segment) => segment.id),
                            startMs: first.startMs,
                            endMs: last.endMs,
                            text: selectedText,
                          });
                      }}
                    >
                      <div style={gridStyle}>
                        <label style={fieldStyle}>
                          {t("selectQuoteStart")}
                          <select
                            style={inputStyle}
                            value={firstSegment}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              setFirstSegment(value);
                              setLastSegment((last) => Math.max(value, last));
                            }}
                          >
                            {selected.segments.map((segment, index) => (
                              <option key={segment.id} value={index}>
                                {index + 1} · {(segment.startMs / 1000).toFixed(1)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={fieldStyle}>
                          {t("selectQuoteEnd")}
                          <select
                            style={inputStyle}
                            value={lastSegment}
                            onChange={(event) => setLastSegment(Number(event.target.value))}
                          >
                            {selected.segments.map((segment, index) =>
                              index >= firstSegment ? (
                                <option key={segment.id} value={index}>
                                  {index + 1} · {(segment.endMs / 1000).toFixed(1)}
                                </option>
                              ) : null,
                            )}
                          </select>
                        </label>
                      </div>
                      <blockquote
                        style={{
                          margin: 0,
                          padding: 16,
                          borderLeft: "3px solid var(--kamala)",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {selectedText}
                      </blockquote>
                      <button type="submit" style={buttonStyle} disabled={busy}>
                        {t("createQuote")}
                      </button>
                    </form>
                  )}
                {!data.quotes.length && <p>{t("emptyQuotes")}</p>}
                {data.quotes.map((quote) => {
                  const source = data.transcripts.find(
                    (item) => item.id === quote.transcriptVersionId,
                  );
                  const eligibility = data.quoteEligibility[quote.id];
                  const valid =
                    active &&
                    source?.masterVersionId === content.currentVersion.id &&
                    source?.revision === quote.transcriptRevision &&
                    source?.review?.decision === "APPROVED" &&
                    !data.transcripts.some((item) => item.parentVersionId === source.id);
                  return (
                    <article
                      key={quote.id}
                      style={{
                        padding: 16,
                        border: "1px solid var(--line)",
                        borderRadius: 16,
                        display: "grid",
                        gap: 12,
                        minWidth: 0,
                      }}
                    >
                      <blockquote style={{ margin: 0, overflowWrap: "anywhere" }}>
                        {quote.text}
                      </blockquote>
                      <span>
                        {!valid || (quote.review?.decision === "APPROVED" && !eligibility?.allowed)
                          ? t("sourceChanged")
                          : quote.review
                            ? t(quote.review.decision === "APPROVED" ? "APPROVED" : "REJECTED")
                            : t("pendingReview")}
                      </span>
                      <div style={rowStyle}>
                        {valid && source && (
                          <button
                            type="button"
                            style={buttonStyle}
                            onClick={() =>
                              playContext(quote.startMs, quote.endMs, source.durationMs)
                            }
                          >
                            {t("playContext")}
                          </button>
                        )}
                        {canReview && valid && active && (
                          <>
                            <button
                              type="button"
                              style={primaryStyle}
                              disabled={busy}
                              onClick={() =>
                                void perform(quote.id, "review-quote", {
                                  expectedRevision: quote.revision,
                                  decision: "APPROVED",
                                })
                              }
                            >
                              {t("approve")}
                            </button>
                            <button
                              type="button"
                              style={buttonStyle}
                              disabled={busy}
                              onClick={() =>
                                void perform(quote.id, "review-quote", {
                                  expectedRevision: quote.revision,
                                  decision: "REJECTED",
                                })
                              }
                            >
                              {t("reject")}
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
              <details style={panelStyle}>
                <summary
                  style={{
                    color: "var(--kamala-deep)",
                    minHeight: 44,
                    cursor: "pointer",
                    fontWeight: 650,
                  }}
                >
                  {t("glossary")}
                </summary>
                {data.glossary.map((entry) => (
                  <div
                    key={entry.id}
                    style={{
                      ...rowStyle,
                      justifyContent: "space-between",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span>{entry.term}</span>
                    <strong>{entry.preferred}</strong>
                  </div>
                ))}
                {canReview && (
                  <form
                    style={{ display: "grid", gap: 12 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void perform(content.id, "glossary", {
                        term,
                        preferred,
                        language: content.language,
                      }).then((ok) => {
                        if (ok) {
                          setTerm("");
                          setPreferred("");
                        }
                      });
                    }}
                  >
                    <div style={gridStyle}>
                      <label style={fieldStyle}>
                        {t("term")}
                        <input
                          style={inputStyle}
                          maxLength={200}
                          required
                          value={term}
                          onChange={(event) => setTerm(event.target.value)}
                        />
                      </label>
                      <label style={fieldStyle}>
                        {t("preferred")}
                        <input
                          style={inputStyle}
                          maxLength={200}
                          required
                          value={preferred}
                          onChange={(event) => setPreferred(event.target.value)}
                        />
                      </label>
                    </div>
                    <button type="submit" style={buttonStyle} disabled={busy}>
                      {t("addTerm")}
                    </button>
                  </form>
                )}
              </details>
            </>
          )}
        </div>
      )}
    </details>
  );
}
