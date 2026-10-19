"use client";

import {
  STUDIO_MEDIA_DEFAULTS,
  type StudioMediaEdits,
  type StudioSegment,
} from "@satsang/distribution-domain";
import { useEffect, useRef, useState } from "react";
import type { PublicStudioPackage } from "../lib/studio-model";
import "./studio-media-editor.css";

const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;

/** Trim on the current export's timeline; keep absolute source evidence on save. */
export function StudioTrimPlayer({
  value,
  output,
  baseStart,
  baseEnd,
  startMs,
  endMs,
  useRendered,
  error,
  onChange,
}: {
  value: PublicStudioPackage;
  output: PublicStudioPackage["outputs"][number];
  baseStart: number;
  baseEnd: number;
  startMs: number;
  endMs: number;
  useRendered: boolean;
  error: string;
  onChange: (span: { startMs: number; endMs: number }) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [ready, setReady] = useState(false);
  const [playError, setPlayError] = useState("");
  const offset = useRendered ? 0 : baseStart / 1000;
  const seconds = (ms: number) => (Number.isFinite(ms) ? (ms - baseStart) / 1000 : "");
  const start = seconds(startMs);
  const end = seconds(endMs);
  const duration = (baseEnd - baseStart) / 1000;
  const src = useRendered
    ? `/distribution/api/studio/${value.id}/assets/${output.id}/media`
    : `/distribution/api/content/${value.source.masterId}/media?versionId=${encodeURIComponent(value.source.versionId)}`;
  useEffect(() => {
    if (startMs === endMs) return;
    stopAt.current = null;
    player.current?.pause();
  }, [startMs, endMs]);
  // Animation frames stop preview closer to the selected boundary than timeupdate alone.
  useEffect(() => {
    if (player.current?.getAttribute("src") !== src) return;
    let frame = 0;
    const tick = () => {
      if (
        player.current &&
        stopAt.current !== null &&
        player.current.currentTime >= stopAt.current
      ) {
        player.current.pause();
        player.current.currentTime = stopAt.current;
        stopAt.current = null;
      }
      if (player.current && !player.current.paused) frame = requestAnimationFrame(tick);
    };
    const media = player.current;
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    media?.addEventListener("play", start);
    return () => {
      cancelAnimationFrame(frame);
      media?.removeEventListener("play", start);
    };
  }, [src]);
  const seek = (seconds: number) => {
    if (!player.current) return;
    player.current.pause();
    stopAt.current = null;
    player.current.currentTime = offset + Math.max(0, Math.min(duration, seconds));
  };
  return (
    <section className="studio-source-player" aria-label="Trim this Short">
      <h4>Trim this Short</h4>
      <p>Times start at zero in this Short. To remove the first two seconds, set Start to 2.00.</p>
      {/* biome-ignore lint/a11y/useMediaCaption: The export already contains its embedded subtitles; editable cues appear below. */}
      <video
        key={src}
        ref={player}
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label="Curated video trim preview"
        onLoadedMetadata={() => {
          setReady(true);
          setPlayError("");
          if (player.current) player.current.currentTime = offset;
        }}
        onTimeUpdate={() =>
          setPosition(Math.max(0, (player.current?.currentTime ?? offset) - offset))
        }
        onError={() => {
          setReady(false);
          setPlayError(
            "This video could not load. Your edits are retained. Retry playback or refresh the package to check file access.",
          );
        }}
      />
      {playError && (
        <p role="alert">
          {playError}{" "}
          <button className="button" type="button" onClick={() => player.current?.load()}>
            Retry video
          </button>
        </p>
      )}
      <p>
        Playhead: {position.toFixed(2)} seconds · Spoken video: {duration.toFixed(2)} seconds
      </p>
      <div className="studio-editor-grid">
        <label>
          Start (seconds)
          <input
            aria-label="Start (seconds)"
            type="number"
            min="0"
            max={duration - 1}
            step="0.01"
            required
            value={start}
            onChange={(e) =>
              onChange({ startMs: baseStart + Math.round(e.target.valueAsNumber * 1000), endMs })
            }
          />
        </label>
        <label>
          End (seconds)
          <input
            aria-label="End (seconds)"
            type="number"
            min="1"
            max={duration}
            step="0.01"
            required
            value={end}
            onChange={(e) =>
              onChange({ startMs, endMs: baseStart + Math.round(e.target.valueAsNumber * 1000) })
            }
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={!ready}
          onClick={() => seek(position - 0.1)}
        >
          Back 0.1s
        </button>
        <button
          className="button"
          type="button"
          disabled={!ready}
          onClick={() => seek(position + 0.1)}
        >
          Forward 0.1s
        </button>
        <button
          className="button"
          type="button"
          disabled={!ready}
          onClick={() =>
            onChange({
              startMs: baseStart + Math.round(Math.min(duration, position) * 1000),
              endMs,
            })
          }
        >
          Set start here
        </button>
        <button
          className="button"
          type="button"
          disabled={!ready}
          onClick={() =>
            onChange({
              startMs,
              endMs: baseStart + Math.round(Math.min(duration, position) * 1000),
            })
          }
        >
          Set end here
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!ready || Boolean(error)}
          onClick={async () => {
            if (!player.current || start === "" || end === "") return;
            player.current.currentTime = offset + start;
            stopAt.current = offset + end;
            try {
              await player.current.play();
              setPlayError("");
            } catch {
              stopAt.current = null;
              setPlayError(
                "Playback could not start. Try Preview trim again; your edits are retained.",
              );
            }
          }}
        >
          Preview trim
        </button>
      </div>
      <p>
        The closing card stays at the end after rebuilding. Preview plays the selected speech;
        subtitle and audio changes appear in the rebuilt file. Nothing is saved until you choose
        Save &amp; rebuild this file.
      </p>
    </section>
  );
}

export function StudioMediaSummary({
  edits,
  label = "File adjustments",
}: { edits?: StudioMediaEdits | undefined; label?: string }) {
  const value = edits ?? STUDIO_MEDIA_DEFAULTS;
  return (
    <p>
      <strong>{label}:</strong>{" "}
      {value.framing === "auto"
        ? `AI portrait framing, focus ${Math.round(value.portraitFocus * 100)}% from left`
        : "Full picture"}
      ; subtitles {value.captions === "default" ? "follow the package setting" : value.captions},{" "}
      {value.subtitleSize} size; {value.speechLevel} speech level; noise reduction{" "}
      {value.reduceNoise ? "on" : "off"}.
    </p>
  );
}

/** Source playback is deliberately separate from the rebuilt, AI-reviewed export. */
export function StudioSourcePlayer({
  value,
  passages,
  onBoundary,
}: {
  value: PublicStudioPackage;
  passages: StudioSegment[];
  onBoundary: (edge: "start" | "end", milliseconds: number) => void;
}) {
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const start = passages[0]?.startMs ?? 0;
  const end = passages.at(-1)?.endMs ?? 0;
  useEffect(() => {
    if (end >= start) stopAt.current = null;
  }, [start, end]);
  const src = `/distribution/api/content/${value.source.masterId}/media?versionId=${encodeURIComponent(value.source.versionId)}`;
  const playback = {
    ref: player,
    controls: true,
    preload: "metadata",
    src,
    onLoadedMetadata: () => {
      setReady(true);
      setError("");
      if (player.current) player.current.currentTime = start / 1000;
    },
    onTimeUpdate: () => {
      const element = player.current;
      if (!element) return;
      setPosition(element.currentTime * 1000);
      if (stopAt.current !== null && element.currentTime * 1000 >= stopAt.current) {
        element.pause();
        stopAt.current = null;
      }
    },
    onError: () => {
      setReady(false);
      setError(
        "The original recording could not load. Your edits are still here. Retry playback; if it still fails, refresh the package to check source access and version.",
      );
    },
  };
  const seek = (delta: number) => {
    if (!player.current) return;
    stopAt.current = null;
    player.current.currentTime = Math.max(
      0,
      Math.min(player.current.duration, player.current.currentTime + delta),
    );
  };
  return (
    <section
      className="studio-source-player"
      aria-label="Original recording editor"
      onChange={(event) => event.stopPropagation()}
    >
      <h4>Listen and choose the passage</h4>
      <p>Original recording. Export adjustments appear after saving and rebuilding this file.</p>
      {value.source.mimeType.startsWith("audio/") ? (
        <audio key={retry} {...playback} aria-label="Original audio" />
      ) : (
        <video key={retry} {...playback} playsInline aria-label="Original video" />
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="button"
            onClick={() => {
              setError("");
              setRetry(retry + 1);
            }}
          >
            Retry playback
          </button>
        </p>
      )}
      <p>
        Selected: {time(start)}–{time(end)} · {((end - start) / 1000).toFixed(1)} seconds. Playhead:{" "}
        {time(position)}.
      </p>
      <div className="actions wrap">
        <button type="button" className="button" disabled={!ready} onClick={() => seek(-5)}>
          Back 5 seconds
        </button>
        <button type="button" className="button" disabled={!ready} onClick={() => seek(5)}>
          Forward 5 seconds
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready || end <= start}
          onClick={async () => {
            if (!player.current) return;
            player.current.currentTime = start / 1000;
            stopAt.current = end;
            try {
              await player.current.play();
            } catch {
              stopAt.current = null;
              setError("Playback was interrupted. Press Play on the recording to try again.");
            }
          }}
        >
          Preview selected passage
        </button>
      </div>
      <div className="studio-editor-grid">
        <label>
          Preview speed
          <select
            defaultValue="1"
            onChange={(e) => {
              if (player.current) player.current.playbackRate = Number(e.target.value);
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Preview volume
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            defaultValue="1"
            onChange={(e) => {
              if (player.current) {
                player.current.volume = Number(e.target.value);
                player.current.muted = Number(e.target.value) === 0;
              }
            }}
          />
        </label>
      </div>
      <div className="actions wrap">
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() => onBoundary("start", position)}
        >
          Start at this passage
        </button>
        <button
          type="button"
          className="button"
          disabled={!ready}
          onClick={() => onBoundary("end", position)}
        >
          End after this passage
        </button>
      </div>
      <p className="muted">
        Selection snaps to transcript passages to avoid cutting words. AI checks the complete
        message again before human approval. Preview speed and volume do not change the export.
      </p>
    </section>
  );
}

export function StudioMediaControls({
  value,
  onChange,
}: { value: StudioMediaEdits; onChange: (value: StudioMediaEdits) => void }) {
  return (
    <fieldset className="studio-export-controls">
      <legend>Video, subtitles and audio in the exported file</legend>
      <div className="studio-editor-grid">
        <label>
          Picture framing
          <select
            value={value.framing}
            onChange={(e) =>
              onChange({ ...value, framing: e.target.value as StudioMediaEdits["framing"] })
            }
          >
            <option value="auto">AI selected portrait framing</option>
            <option value="full-picture">Keep the full picture</option>
          </select>
        </label>
        <label>
          Portrait focus: {Math.round(value.portraitFocus * 100)}% from left
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            disabled={value.framing !== "auto"}
            value={value.portraitFocus}
            onChange={(e) => onChange({ ...value, portraitFocus: Number(e.target.value) })}
          />
          <small>
            Used wherever AI has marked portrait cropping safe. Proportions stay unchanged.
          </small>
        </label>
        <label>
          Embedded subtitles
          <select
            value={value.captions}
            onChange={(e) =>
              onChange({ ...value, captions: e.target.value as StudioMediaEdits["captions"] })
            }
          >
            <option value="default">Use package setting</option>
            <option value="on">On for this file</option>
            <option value="off">Off for this file</option>
          </select>
        </label>
        <label>
          Subtitle size
          <select
            value={value.subtitleSize}
            onChange={(e) =>
              onChange({
                ...value,
                subtitleSize: e.target.value as StudioMediaEdits["subtitleSize"],
              })
            }
          >
            <option value="small">Small</option>
            <option value="standard">Standard</option>
            <option value="large">Large</option>
          </select>
          <small>Placed just below the picture so the speaker stays visible.</small>
        </label>
        <label>
          Speech level
          <select
            value={value.speechLevel}
            onChange={(e) =>
              onChange({ ...value, speechLevel: e.target.value as StudioMediaEdits["speechLevel"] })
            }
          >
            <option value="softer">Softer</option>
            <option value="standard">Standard</option>
            <option value="louder">Louder</option>
          </select>
          <small>
            Measured loudness with peak protection; the speaker’s voice stays unchanged.
          </small>
        </label>
        <label className="correction-file-choice">
          <input
            type="checkbox"
            checked={value.reduceNoise}
            onChange={(e) => onChange({ ...value, reduceNoise: e.target.checked })}
          />
          Reduce steady background noise
        </label>
      </div>
      <p>
        Channel branding and the closing card are retained. Check the rebuilt picture, sound and
        captions before sending to the Approver.
      </p>
    </fieldset>
  );
}
