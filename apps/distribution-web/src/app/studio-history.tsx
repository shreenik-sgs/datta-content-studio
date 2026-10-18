"use client";

import { studioChannelLabel } from "@satsang/distribution-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type StudioHistoryEntry,
  mergeStudioHistory,
  readStudioHistory,
  studioHistoricalFileChange,
  studioHistoryAction,
  studioHistoryChange,
} from "../lib/studio-history-model";
import { STUDIO_STATUS_LABELS } from "../lib/studio-model";
import { useHubLocale, useHubTimestamp } from "./hub-locale";
import "./studio-history.css";

/** A changed package or current revision starts a fresh, collapsed history view. */
export function StudioHistory(props: { packageId: string; currentRevision: number }) {
  return <PackageHistory key={`${props.packageId}:${props.currentRevision}`} {...props} />;
}

function PackageHistory({
  packageId,
  currentRevision,
}: { packageId: string; currentRevision: number }) {
  const { timezone, timezoneSource } = useHubLocale();
  const formatTime = useHubTimestamp();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<StudioHistoryEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [expandedRevision, setExpandedRevision] = useState<number | null>(null);
  const request = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const failedOffset = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const generation = ++request.current;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      failedOffset.current = offset;
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/distribution/api/studio/${encodeURIComponent(packageId)}/history?offset=${offset}&limit=20`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error("HISTORY_UNAVAILABLE");
        const result = readStudioHistory(await response.json(), packageId);
        if (generation !== request.current) return;
        setEntries((previous) => mergeStudioHistory(offset ? previous : [], result.revisions));
        setNextOffset(result.nextOffset);
        setLoaded(true);
      } catch {
        if (generation === request.current && !controller.signal.aborted)
          setError("Activity history could not be loaded. Your current package is unchanged.");
      } finally {
        if (generation === request.current) setLoading(false);
      }
    },
    [packageId],
  );

  useEffect(() => {
    if (open) void load(0);
    return () => {
      request.current++;
      pending.current?.abort();
    };
  }, [open, load]);

  return (
    <details className="studio-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        Activity & review history{" "}
        <span className="studio-history-timezone">
          · {timezone}
          {timezoneSource === "fallback" ? " (fallback)" : ""}
        </span>
      </summary>
      {open && (
        <div className="studio-history-body">
          <p>
            This log records generation, submission and review. These events do not create extra
            copies of the media. Only generation writes new media files.
          </p>
          <p className="muted">
            Historical entries are read-only metadata. Review and publish from the current package.{" "}
            {timezoneSource === "profile"
              ? `Times are shown in your profile timezone (${timezone}).`
              : "Times are shown in UTC because your profile timezone is unavailable."}
          </p>
          {error && (
            <div className="notice" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="button"
                disabled={loading}
                onClick={() => void load(failedOffset.current)}
              >
                Retry history
              </button>
            </div>
          )}
          {loading && <output>Loading activity history…</output>}
          {loaded && !entries.length && !loading && <p>No recorded activity is available.</p>}
          <ol className="studio-history-list">
            {entries.map((entry) => {
              const previous = entries.find(
                (candidate) => candidate.revision === entry.revision - 1,
              );
              const panelId = `history-${packageId}-${entry.revision}`;
              const expanded = expandedRevision === entry.revision;
              return (
                <li key={entry.revision}>
                  <button
                    type="button"
                    className="studio-history-version"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setExpandedRevision(expanded ? null : entry.revision)}
                  >
                    <span className="studio-history-version-title">
                      <strong>
                        {studioHistoryAction(entry.action)}
                        {entry.revision === currentRevision ? " · latest" : ""}
                      </strong>
                      <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                    </span>
                    <span>{STUDIO_STATUS_LABELS[entry.package.status]}</span>
                    <span className="muted">{studioHistoryChange(entry, previous)}</span>
                    <span className="studio-history-toggle">
                      {expanded ? "Hide files" : "Inspect files"}
                    </span>
                  </button>
                  <div id={panelId} hidden={!expanded} className="studio-history-snapshot">
                    {expanded && (
                      <>
                        <p>
                          {entry.package.outputs.length} derived outputs ·{" "}
                          {entry.package.outputs.filter((output) => output.included).length}{" "}
                          included
                        </p>
                        {entry.package.provenance && (
                          <p>
                            Last content generation:{" "}
                            <time dateTime={entry.package.provenance.generatedAt}>
                              {formatTime(entry.package.provenance.generatedAt)}
                            </time>
                          </p>
                        )}
                        {!entry.package.outputs.length ? (
                          <p>No derived files had been created at this point.</p>
                        ) : (
                          <section
                            className="studio-history-table-scroll"
                            aria-label={`Files at activity ${entry.revision}`}
                            // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow table must be keyboard scrollable on narrow screens.
                            tabIndex={0}
                          >
                            <table className="studio-history-table">
                              <caption>Files recorded at this activity</caption>
                              <thead>
                                <tr>
                                  <th scope="col">Filename</th>
                                  <th scope="col">Channel / type</th>
                                  <th scope="col">File change</th>
                                  <th scope="col">Included</th>
                                </tr>
                              </thead>
                              <tbody>
                                {entry.package.outputs.map((output) => (
                                  <tr key={output.id}>
                                    <th scope="row">
                                      <span>{output.asset?.filename ?? "No generated file"}</span>
                                      {output.asset && (
                                        <small>SHA-256: {output.asset.sha256.slice(0, 12)}…</small>
                                      )}
                                      {output.captions.map((caption) => (
                                        <small key={caption.language}>
                                          CC ({caption.language}): {caption.asset.filename}
                                        </small>
                                      ))}
                                    </th>
                                    <td>
                                      {studioChannelLabel(output.channel)}
                                      <small>
                                        {output.format} · {output.language}
                                        {output.asset ? ` · ${output.asset.mimeType}` : ""}
                                      </small>
                                    </td>
                                    <td>
                                      {studioHistoricalFileChange(output, previous, entry.revision)}
                                    </td>
                                    <td>
                                      {entry.package.status === "DISCARDED"
                                        ? "Package discarded"
                                        : output.included
                                          ? "Included"
                                          : "Excluded"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </section>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {nextOffset !== null && (
            <button
              type="button"
              className="button"
              disabled={loading}
              onClick={() => void load(nextOffset)}
            >
              Load earlier activity
            </button>
          )}
        </div>
      )}
    </details>
  );
}
