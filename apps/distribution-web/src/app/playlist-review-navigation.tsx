"use client";
import { type PublicStudioPackage, STUDIO_STATUS_LABELS } from "../lib/studio-model";

export function PlaylistReviewNavigation({
  title,
  packages,
  selectedId,
  completed,
  disabled,
  onSelect,
  onBack,
  onAllFiles,
}: {
  title: string;
  packages: readonly PublicStudioPackage[];
  selectedId: string | null;
  completed: boolean;
  disabled: boolean;
  onSelect: (value: PublicStudioPackage) => void;
  onBack?: (() => void) | undefined;
  onAllFiles?: (() => void) | undefined;
}) {
  const index = packages.findIndex((item) => item.id === selectedId);
  const next = index >= 0 ? packages[index + 1] : undefined;
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
                {position + 1}. {item.source.title} · {STUDIO_STATUS_LABELS[item.status]}
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
      <p className="muted">
        {completed
          ? "Browse the approved files for each recording. Approved files are locked against editing."
          : "The six steps below belong to the selected recording. Moving to another recording does not approve or publish its files."}
      </p>
    </nav>
  );
}
