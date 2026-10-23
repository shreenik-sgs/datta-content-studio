"use client";
import { type PublicStudioPackage, studioStatusLabel } from "../lib/studio-model";
import { studioSourceVideo } from "../lib/studio-source-outcome";

export function PlaylistReviewNavigation({
  title,
  packages,
  selectedId,
  completed,
  disabled,
  onSelect,
  onBack,
  onAllFiles,
  sourceLinks = {},
}: {
  title: string;
  packages: readonly PublicStudioPackage[];
  selectedId: string | null;
  completed: boolean;
  disabled: boolean;
  onSelect: (value: PublicStudioPackage) => void;
  onBack?: (() => void) | undefined;
  onAllFiles?: (() => void) | undefined;
  sourceLinks?: Readonly<Record<string, string>> | undefined;
}) {
  const index = packages.findIndex((item) => item.id === selectedId);
  const next = index >= 0 ? packages[index + 1] : undefined;
  const selected = packages[index];
  const source = selected && studioSourceVideo(sourceLinks[selected.source.masterId]);
  return (
    <nav className="playlist-review-navigation" aria-label="Bundle review">
      <div className="actions wrap">
        <strong>{title}</strong>
        {onAllFiles && (
          <button type="button" className="button primary" disabled={disabled} onClick={onAllFiles}>
            All bundle files
          </button>
        )}
        <button type="button" className="button" disabled={disabled} onClick={onBack}>
          Back to bundle overview
        </button>
      </div>
      <div className="actions wrap">
        <label>
          {index >= 0 ? `Recording ${index + 1} of ${packages.length}` : "Choose a recording"}
          <select
            aria-label="Recording in bundle"
            disabled={disabled}
            value={selectedId ?? ""}
            onChange={(event) => {
              const value = packages.find((item) => item.id === event.target.value);
              if (value) onSelect(value);
            }}
          >
            {index < 0 && <option value="">Choose a recording</option>}
            {packages.map((item, position) => (
              <option key={item.id} value={item.id}>
                {position + 1}. {item.source.title}
                {packages.some(
                  (p) =>
                    p.source.title === item.source.title &&
                    p.source.masterId !== item.source.masterId,
                )
                  ? ` · source ${studioSourceVideo(sourceLinks[item.source.masterId])?.id ?? item.source.masterId.slice(0, 8)}`
                  : ""}
                {" · "}
                {studioStatusLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={disabled || !next}
          onClick={() => next && onSelect(next)}
        >
          Next recording →
        </button>
      </div>
      {source && (
        <p>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            Original video · {source.id}
          </a>
        </p>
      )}
      <p className="muted">
        {completed
          ? "Browse the approved files for each recording. Approved files are locked against editing."
          : "The six steps below belong to the selected recording. Moving to another recording does not approve or publish its files."}
      </p>
    </nav>
  );
}
