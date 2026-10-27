"use client";
import { studioCanEditFile } from "@satsang/distribution-domain";
import { useState } from "react";
import type { PublicStudioPackage } from "../lib/studio-model";

export function StudioClosingControls({
  value,
  busy,
  available,
  onAction,
}: {
  value: PublicStudioPackage;
  busy: boolean;
  available: boolean;
  onAction: (action: string, command: unknown) => Promise<unknown>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  if (
    value.status !== "DRAFT" ||
    value.approval ||
    value.outputs.some((o) => !studioCanEditFile(value, o, ["content.create"]))
  )
    return null;
  const videos = value.outputs.filter(
    (o) => o.included && ["short", "video", "reel"].includes(o.format),
  );
  if (!videos.length) return null;
  const target = value.request.youtubeClosing;
  return (
    <details>
      <summary>Check closing cards and channel links</summary>
      <p>
        Studio checks the actual saved videos, sound, subtitles and closing cards. Correct files are
        kept unchanged. When a card needs updating, only the ending is encoded; the original speech
        and preceding footage are copied. All files remain drafts.
      </p>
      <form
        key={value.revision}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!confirmed) return;
          const form = new FormData(event.currentTarget);
          await onAction("verify-closings", {
            expectedRevision: value.revision,
            ...(target
              ? {
                  target: {
                    label: String(form.get("label") ?? ""),
                    url: String(form.get("url") ?? ""),
                    ...(form.get("fullVideosUrl")
                      ? { fullVideosUrl: String(form.get("fullVideosUrl")) }
                      : {}),
                  },
                }
              : {}),
          });
          setConfirmed(false);
        }}
      >
        <fieldset disabled={busy || !available}>
          <legend>Closing cards for {videos.length} draft videos in this recording</legend>
          {target && (
            <>
              <label>
                Subscription channel name
                <input name="label" required maxLength={100} defaultValue={target.label} />
              </label>
              <label>
                Subscribe on YouTube
                <input name="url" type="url" required defaultValue={target.url} />
              </label>
              <label>
                Watch full videos on YouTube
                <input name="fullVideosUrl" type="url" defaultValue={target.fullVideosUrl ?? ""} />
              </label>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I checked these destinations and want Studio to verify or update the draft closing
            cards.
          </label>
          <button type="submit" className="button" disabled={!confirmed}>
            Check and update closing cards
          </button>
        </fieldset>
      </form>
    </details>
  );
}
