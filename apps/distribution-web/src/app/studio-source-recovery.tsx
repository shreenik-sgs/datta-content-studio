"use client";
import { useState } from "react";
import type { PublicStudioPackage } from "../lib/studio-model";

export function StudioSourceRecovery({
  value,
  busy,
  available,
  onAction,
}: {
  value: Pick<PublicStudioPackage, "request" | "revision">;
  busy: boolean;
  available: boolean;
  onAction: (action: string, command: unknown) => Promise<unknown>;
}) {
  const [guidance, setGuidance] = useState(value.request.instructions);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !available || guidance.trim() === value.request.instructions.trim()) return;
        void onAction("regenerate", {
          expectedRevision: value.revision,
          request: { ...value.request, instructions: guidance.trim() },
        });
      }}
    >
      <p>
        Review the original recording first. If it has a complete teaching the AI missed, explain
        where to find it. For a music-only or incomplete source, use the full discourse instead.
      </p>
      <label>
        Updated guidance
        <textarea
          name="instructions"
          value={guidance}
          rows={5}
          maxLength={4000}
          onChange={(event) => setGuidance(event.target.value)}
        />
      </label>
      <p className="muted">
        Change the guidance to enable generation. An unchanged retry would reuse the same
        assessment.
      </p>
      <button
        type="submit"
        className="button"
        disabled={busy || !available || guidance.trim() === value.request.instructions.trim()}
      >
        Generate with updated guidance
      </button>
      <p className="muted">
        Only this recording is reconsidered. Other recordings and their files are unchanged.
      </p>
    </form>
  );
}
