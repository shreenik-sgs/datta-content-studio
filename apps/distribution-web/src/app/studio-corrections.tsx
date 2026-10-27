"use client";
import {
  STUDIO_COPY_LIMITS,
  STUDIO_MEDIA_DEFAULTS,
  STUDIO_TITLE_LIMITS,
  type StudioMediaEdits,
  type StudioSegment,
  studioCanEditFile,
  studioCaptionsEnabled,
  studioClosingCardPlan,
  studioOutputChannelLabel,
  studioSourceRange,
  studioVideoDurationLimitMs,
} from "@satsang/distribution-domain";
import { useEffect, useState } from "react";
import type { PublicStudioPackage } from "../lib/studio-model";
import { useHubTimestamp } from "./hub-locale";
import { StudioClosingControls } from "./studio-closing-controls";

import {
  StudioMediaControls,
  StudioMediaSummary,
  StudioSourcePlayer,
  StudioTrimPlayer,
} from "./studio-media-editor";

type Action = (
  action: string,
  command: unknown,
) => Promise<{ package?: PublicStudioPackage } | null>;
export function StudioCorrections({
  value,
  busy,
  available,
  onAction,
  initialOutputId,
  onEditingChange,
}: {
  initialOutputId?: string | undefined;
  onEditingChange?: ((dirty: boolean) => void) | undefined;
  value: PublicStudioPackage;
  busy: boolean;
  available: boolean;
  onAction: Action;
}) {
  const editable = value.outputs.filter((o) => studioCanEditFile(value, o, ["content.create"]));
  const requested = editable.filter((o) => o.correction?.state === "pending");
  const [selected, setSelected] = useState<string[]>(requested.map((o) => o.id));
  const [mode, setMode] = useState<"ai" | "manual">(initialOutputId ? "manual" : "ai");
  const [editingId, setEditingId] = useState(
    editable.find((o) => o.id === initialOutputId)?.id ?? requested[0]?.id ?? editable[0]?.id ?? "",
  );
  const formatTime = useHubTimestamp();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onEditingChange?.(dirty);
    return () => onEditingChange?.(false);
  }, [dirty, onEditingChange]);
  const leave = () => !dirty || window.confirm("Discard unsaved edits to this file?");
  return (
    <section aria-label="File corrections">
      <h3>Fix selected files</h3>
      <p>
        Choose the files to change. Other files keep their media, timestamps and review history.
      </p>
      {requested.map((o) => (
        <blockquote key={o.id}>
          <strong>
            {studioOutputChannelLabel(o)} · {o.language}
          </strong>
          <p>{o.correction?.comment}</p>
          <small>Requested {formatTime(o.correction?.requestedAt ?? value.updatedAt)}</small>
        </blockquote>
      ))}
      <div className="actions wrap">
        <button
          type="button"
          className="button"
          aria-pressed={mode === "ai"}
          onClick={() => {
            if (mode === "manual" && !leave()) return;
            setDirty(false);
            setMode("ai");
          }}
        >
          Apply suggestions with AI
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={mode === "manual"}
          onClick={() => setMode("manual")}
        >
          Edit file, video & audio
        </button>
      </div>
      {mode === "ai" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            await onAction("regenerate", {
              expectedRevision: value.revision,
              outputIds: selected,
              mode: "ai",
              request: { ...value.request, instructions: String(form.get("instructions") ?? "") },
            });
          }}
        >
          <fieldset disabled={busy || !available}>
            <legend>Files for AI correction</legend>
            {editable.map((o) => (
              <label key={o.id} className="correction-file-choice">
                <input
                  type="checkbox"
                  checked={selected.includes(o.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id),
                    )
                  }
                />
                <span>
                  {studioOutputChannelLabel(o)} · {o.language} · {o.title}
                  {o.asset && <small>{o.asset.filename}</small>}
                </span>
              </label>
            ))}
            <p>
              Each selected file receives its own Approver comments automatically. Add any further
              instructions below.
            </p>
            <label>
              Additional correction instructions
              <textarea
                name="instructions"
                rows={3}
                maxLength={4000}
                defaultValue=""
                placeholder="For example: shorten the introduction without changing the teaching."
              />
            </label>
            <button className="button primary" type="submit" disabled={!selected.length}>
              Generate corrections for {selected.length} selected{" "}
              {selected.length === 1 ? "file" : "files"}
            </button>
          </fieldset>
        </form>
      ) : (
        <>
          <label>
            File to edit
            <select
              aria-label="File to edit"
              value={editingId}
              disabled={busy}
              onChange={(e) => {
                if (leave()) {
                  setDirty(false);
                  setEditingId(e.target.value);
                }
              }}
            >
              {editable.map((o) => (
                <option key={o.id} value={o.id}>
                  {studioOutputChannelLabel(o)} · {o.language} · {o.title}
                </option>
              ))}
            </select>
          </label>
          <ManualFile
            key={`${editingId}-${value.revision}`}
            value={value}
            outputId={editingId}
            busy={busy}
            available={available}
            onAction={onAction}
            onDirty={setDirty}
          />
        </>
      )}
      <StudioClosingControls
        value={value}
        busy={busy || dirty}
        available={available}
        onAction={onAction}
      />
      {!available && (
        <p aria-live="polite">
          Generation is unavailable. You can save manual edits; rendering and AI corrections require
          the generation service.
        </p>
      )}
    </section>
  );
}
export function ManualFile({
  value,
  outputId,
  busy,
  available,
  onAction,
  onDirty,
}: {
  onDirty?: ((dirty: boolean) => void) | undefined;
  value: PublicStudioPackage;
  outputId: string;
  busy: boolean;
  available: boolean;
  onAction: Action;
}) {
  const output = value.outputs.find((o) => o.id === outputId);
  const source = value.provenance?.transcript;
  const [ids, setIds] = useState(output?.sourceSegmentIds ?? []);
  const [cues, setCues] = useState<StudioSegment[]>(
    output?.captionCues ??
      source?.segments
        .filter((s) => ids.includes(s.id))
        .map((s) => ({ ...s, text: output?.language === source.language ? s.text : "" })) ??
      [],
  );
  const [mediaEdits, setMediaEdits] = useState<StudioMediaEdits>({
    ...STUDIO_MEDIA_DEFAULTS,
    ...output?.mediaEdits,
  });
  const [sourceTrim, setSourceTrim] = useState(output?.sourceTrim ?? null);
  const [sourceSelectionChanged, setSourceSelectionChanged] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const markDirty = () => {
    setDirty(true);
    onDirty?.(true);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (!output || !source)
    return (
      <p role="alert">
        This file has no editable source evidence. Refresh the package or run AI correction first.
      </p>
    );
  const video = ["short", "reel", "video"].includes(output.format);
  const range = (start: string, end: string) => {
    const a = source.segments.findIndex((s) => s.id === start);
    const b = source.segments.findIndex((s) => s.id === end);
    if (a < 0 || b < a) {
      setError(
        "The last passage must follow the first passage. Adjust the other end of the selection first.",
      );
      return;
    }
    setError("");
    markDirty();
    const chosen = source.segments.slice(a, b + 1);
    setIds(chosen.map((s) => s.id));
    setSourceTrim(null);
    setSourceSelectionChanged(true);
    setCues(
      chosen.map((s) => ({
        ...s,
        text:
          cues.find((c) => c.id === s.id)?.text ??
          (output.language === source.language ? s.text : ""),
      })),
    );
  };
  const passages = source.segments.filter((s) => ids.includes(s.id));
  let trimError = "";
  let selected = {
    startMs: passages[0]?.startMs ?? 0,
    endMs: passages.at(-1)?.endMs ?? 0,
    segments: passages,
  };
  try {
    selected = studioSourceRange(ids, source, output.format, sourceTrim);
  } catch {
    trimError = "Choose a start and end inside this video, keeping at least one second.";
  }
  const selectedCues = selected.segments.map((s) => ({
    ...s,
    text: cues.find((c) => c.id === s.id)?.text ?? "",
  }));
  const samePassages =
    !sourceSelectionChanged && JSON.stringify(ids) === JSON.stringify(output.sourceSegmentIds);
  const baseStart = samePassages
    ? (output.startMs ?? selected.startMs)
    : (passages[0]?.startMs ?? 0);
  const baseEnd = samePassages ? (output.endMs ?? selected.endMs) : (passages.at(-1)?.endMs ?? 0);
  if (sourceTrim && (sourceTrim.startMs < baseStart || sourceTrim.endMs > baseEnd))
    trimError =
      "Keep the trim within this video. Use Advanced to choose a different source passage.";
  const duration = selected.endMs - selected.startMs;
  const exportDuration = duration > 0 ? studioClosingCardPlan(duration).endMs : 0;
  const tooLong =
    video && exportDuration > studioVideoDurationLimitMs(output.channel, output.format);
  const missingCaption = video && selectedCues.some((cue) => !cue.text.trim());
  return (
    <form
      className="studio-file-editor"
      onChange={markDirty}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || saving || tooLong || missingCaption || trimError) return;
        const f = new FormData(e.currentTarget);
        setSaving(true);
        setError("");
        try {
          const saved = await onAction("revise", {
            expectedRevision: value.revision,
            render: available,
            comment: String(f.get("comment") ?? ""),
            outputs: [
              {
                id: output.id,
                included: output.included,
                title: String(f.get("title")),
                body: String(f.get("body")),
                sourceSegmentIds: ids,
                ...(video ? { captionCues: selectedCues, mediaEdits, sourceTrim } : {}),
              },
            ],
          });
          if (saved?.package) {
            setDirty(false);
            onDirty?.(false);
          } else
            setError(
              "The save could not be confirmed. Your edits remain here. Check the package message before retrying; refresh its status if the connection was interrupted.",
            );
        } catch {
          setError(
            "The save could not be confirmed. Your edits remain here. Check the connection and refresh the package status before retrying.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={busy || saving}>
        {dirty && <output>Unsaved changes to this file</output>}
        {error && <p role="alert">{error}</p>}
        {video && (
          <StudioTrimPlayer
            value={value}
            output={output}
            baseStart={baseStart}
            baseEnd={baseEnd}
            useRendered={samePassages && Boolean(output.asset)}
            startMs={sourceTrim?.startMs ?? baseStart}
            endMs={sourceTrim?.endMs ?? baseEnd}
            error={trimError}
            onChange={(next) => {
              setSourceTrim(next);
              markDirty();
            }}
          />
        )}
        {video && (
          <details>
            <summary>Advanced: choose a different source passage</summary>
            <StudioSourcePlayer
              value={value}
              passages={passages}
              onBoundary={(edge, ms) => {
                const current =
                  source.segments.find((s) => ms >= s.startMs && ms < s.endMs) ??
                  (edge === "start"
                    ? source.segments.find((s) => s.startMs >= ms)
                    : source.segments.findLast((s) => s.endMs <= ms));
                if (!current) {
                  setError("Move the playhead to a spoken passage before setting a boundary.");
                  return;
                }
                range(
                  edge === "start" ? current.id : (ids[0] ?? current.id),
                  edge === "end" ? current.id : (ids.at(-1) ?? current.id),
                );
              }}
            />
            <div className="studio-editor-grid">
              {" "}
              <label>
                First source passage
                <select
                  aria-label="First source passage"
                  value={ids[0]}
                  onChange={(e) => range(e.target.value, ids.at(-1) ?? e.target.value)}
                >
                  {source.segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.startMs / 1000).toFixed(1)}s · {s.text.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Last source passage
                <select
                  aria-label="Last source passage"
                  value={ids.at(-1)}
                  onChange={(e) => range(ids[0] ?? e.target.value, e.target.value)}
                >
                  {source.segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {(s.endMs / 1000).toFixed(1)}s · {s.text.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        )}
        <label>
          Title
          <input
            name="title"
            defaultValue={output.title}
            required
            maxLength={STUDIO_TITLE_LIMITS[output.channel]}
          />
        </label>
        <label>
          Posting text
          <textarea
            name="body"
            rows={8}
            defaultValue={output.body}
            required
            maxLength={STUDIO_COPY_LIMITS[output.channel]}
          />
        </label>
        <p>
          Keep the source channel’s attribution and subscription text. Only this file is rebuilt; AI
          review and human approval are required again.
        </p>
        {video && (
          <StudioMediaControls
            value={mediaEdits}
            onChange={(next) => {
              setMediaEdits(next);
              markDirty();
            }}
          />
        )}
        {video && (
          <details open>
            <summary>Subtitle text</summary>
            <p>
              Captions follow the trimmed video. Check the first and last subtitle and remove any
              words you have cut from the audio. Maximum clip length for{" "}
              {studioOutputChannelLabel(output)} is{" "}
              {studioVideoDurationLimitMs(output.channel, output.format) / 1000} seconds.
            </p>
            {tooLong && (
              <p role="alert">
                This selection plus the closing card is {(exportDuration / 1000).toFixed(1)}{" "}
                seconds. Choose a shorter complete passage; {studioOutputChannelLabel(output)}{" "}
                allows {studioVideoDurationLimitMs(output.channel, output.format) / 1000} seconds.
              </p>
            )}
            {missingCaption && (
              <p role="alert">
                Enter the {output.language} subtitle text for every selected passage. Newly added
                passages need their translation, even when captions are hidden, so the reviewer can
                verify the meaning.
              </p>
            )}
            {!studioCaptionsEnabled(mediaEdits, value.request.captions) && (
              <p>
                Subtitles will be hidden in this export. Their text remains available for review.
              </p>
            )}
            {selectedCues.map((c) => (
              <label key={c.id}>
                Subtitle {((c.startMs - selected.startMs) / 1000).toFixed(2)}–
                {((c.endMs - selected.startMs) / 1000).toFixed(2)} seconds
                <textarea
                  rows={2}
                  required
                  maxLength={4000}
                  value={c.text}
                  onChange={(e) =>
                    setCues(
                      cues.map((old) => (old.id === c.id ? { ...old, text: e.target.value } : old)),
                    )
                  }
                />
              </label>
            ))}
            {output.language !== source.language && !output.captionCues && (
              <p>
                This older file does not have editable translated cues. Enter the translation above,
                or use AI correction first to generate editable cues.
              </p>
            )}
          </details>
        )}
        <label>
          Response to reviewer
          <textarea name="comment" rows={3} maxLength={4000} />
        </label>
        <button
          className="button primary"
          type="submit"
          disabled={tooLong || missingCaption || Boolean(trimError)}
        >
          {saving ? "Saving…" : available ? "Save & rebuild this file" : "Save edits for this file"}
        </button>
      </fieldset>
    </form>
  );
}

export function StudioCorrectionComparison({ value }: { value: PublicStudioPackage }) {
  return (
    <section aria-label="Correction comparison">
      {value.outputs
        .filter((o) => o.correction && o.correction.state !== "pending")
        .map((o) => (
          <details key={o.id}>
            <summary>
              Compare changes: {studioOutputChannelLabel(o)} · {o.language}
            </summary>
            <p>
              <strong>Reviewer requested:</strong> {o.correction?.comment}
            </p>
            <h4>Before</h4>
            <strong>{o.correction?.before.title}</strong>
            <p style={{ whiteSpace: "pre-wrap" }}>{o.correction?.before.body}</p>
            <h4>After</h4>
            <strong>{o.title}</strong>
            <p style={{ whiteSpace: "pre-wrap" }}>{o.body}</p>
            <p>
              Source passage before: {passage(value, o.correction?.before.sourceSegmentIds ?? [])}.
              After: {passage(value, o.sourceSegmentIds)}.
            </p>
            {o.mediaEdits && (
              <>
                <StudioMediaSummary label="Media before" edits={o.correction?.before.mediaEdits} />
                <StudioMediaSummary label="Media after" edits={o.mediaEdits} />
              </>
            )}
            {o.captionCues && (
              <details>
                <summary>Caption comparison</summary>
                {o.captionCues.map((c) => (
                  <p key={c.id}>
                    <strong>{(c.startMs / 1000).toFixed(1)}s</strong>
                    <br />
                    Before:{" "}
                    {o.correction?.before.captionCues?.find((old) => old.id === c.id)?.text ??
                      "Earlier caption is available in activity history"}
                    <br />
                    After: {c.text}
                  </p>
                ))}
              </details>
            )}
            <p>Preview the generated file above before resubmitting. Approval is still required.</p>
          </details>
        ))}
    </section>
  );
}

function passage(value: PublicStudioPackage, ids: string[]) {
  const segments = value.provenance?.transcript.segments.filter((s) => ids.includes(s.id)) ?? [];
  return segments.length
    ? `${((segments[0]?.startMs ?? 0) / 1000).toFixed(1)}–${((segments.at(-1)?.endMs ?? 0) / 1000).toFixed(1)} seconds`
    : "See source evidence";
}
