"use client";
import {
  STUDIO_BRAND_SIGNATURE,
  STUDIO_COPY_LIMITS,
  STUDIO_TITLE_LIMITS,
  type StudioSegment,
  studioChannelLabel,
  studioVideoDurationLimitMs,
} from "@satsang/distribution-domain";
import { useState } from "react";
import type { PublicStudioPackage } from "../lib/studio-model";
import { useHubTimestamp } from "./hub-locale";

type Action = (
  action: string,
  command: unknown,
) => Promise<{ package?: PublicStudioPackage } | null>;
export function StudioCorrections({
  value,
  busy,
  available,
  onAction,
}: { value: PublicStudioPackage; busy: boolean; available: boolean; onAction: Action }) {
  const requested = value.outputs.filter((o) => o.included && o.correction?.state === "pending");
  const [selected, setSelected] = useState<string[]>(requested.map((o) => o.id));
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [editingId, setEditingId] = useState(
    requested[0]?.id ?? value.outputs.find((o) => o.included)?.id ?? "",
  );
  const formatTime = useHubTimestamp();
  return (
    <section aria-label="File corrections">
      <h3>Fix selected files</h3>
      <p>
        Choose the files to change. Other files keep their media, timestamps and review history.
      </p>
      {requested.map((o) => (
        <blockquote key={o.id}>
          <strong>
            {studioChannelLabel(o.channel)} · {o.language}
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
          onClick={() => setMode("ai")}
        >
          Apply suggestions with AI
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={mode === "manual"}
          onClick={() => setMode("manual")}
        >
          Edit text, clip & captions
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
            {value.outputs
              .filter((o) => o.included)
              .map((o) => (
                <label key={o.id} className="correction-file-choice">
                  <input
                    type="checkbox"
                    checked={selected.includes(o.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, o.id]
                          : selected.filter((id) => id !== o.id),
                      )
                    }
                  />
                  <span>
                    {studioChannelLabel(o.channel)} · {o.language} · {o.title}
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
              onChange={(e) => setEditingId(e.target.value)}
            >
              {value.outputs
                .filter((o) => o.included)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {studioChannelLabel(o.channel)} · {o.language} · {o.title}
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
          />
        </>
      )}
      {!available && (
        <p aria-live="polite">
          Generation is unavailable. You can save text edits; rendering and AI corrections require
          the generation service.
        </p>
      )}
    </section>
  );
}
function ManualFile({
  value,
  outputId,
  busy,
  available,
  onAction,
}: {
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
  if (!output || !source) return null;
  const video = ["short", "reel"].includes(output.format);
  const range = (start: string, end: string) => {
    const a = source.segments.findIndex((s) => s.id === start);
    const b = source.segments.findIndex((s) => s.id === end);
    if (a < 0 || b < a) return;
    const chosen = source.segments.slice(a, b + 1);
    setIds(chosen.map((s) => s.id));
    setCues(
      chosen.map((s) => ({
        ...s,
        text:
          cues.find((c) => c.id === s.id)?.text ??
          (output.language === source.language ? s.text : ""),
      })),
    );
  };
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const saved = await onAction("revise", {
          expectedRevision: value.revision,
          comment: String(f.get("comment") ?? ""),
          outputs: [
            {
              id: output.id,
              included: output.included,
              title: String(f.get("title")),
              body: String(f.get("body")),
              sourceSegmentIds: ids,
              ...(video ? { captionCues: cues } : {}),
            },
          ],
        });
        if (saved?.package && available)
          await onAction("regenerate", {
            expectedRevision: saved.package.revision,
            outputIds: [output.id],
            mode: "render",
          });
      }}
    >
      <fieldset disabled={busy}>
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
          Keep the {STUDIO_BRAND_SIGNATURE} signature. Saving renders this file using your exact
          edits.
        </p>
        {video && (
          <details open>
            <summary>Clip and subtitle editor</summary>
            <p>
              Select complete source passages. Source audio and caption timing stay tied to the
              master; maximum clip length for {studioChannelLabel(output.channel)} is{" "}
              {studioVideoDurationLimitMs(output.channel) / 1000} seconds.
            </p>
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
            {cues.map((c, i) => (
              <label key={c.id}>
                Subtitle {(c.startMs / 1000).toFixed(1)}–{(c.endMs / 1000).toFixed(1)} seconds
                <textarea
                  rows={2}
                  required
                  maxLength={4000}
                  value={c.text}
                  onChange={(e) =>
                    setCues(
                      cues.map((old, n) => (n === i ? { ...old, text: e.target.value } : old)),
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
        <button className="button primary" type="submit">
          {available ? "Save & render this file" : "Save edits for this file"}
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
              Compare changes: {studioChannelLabel(o.channel)} · {o.language}
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
