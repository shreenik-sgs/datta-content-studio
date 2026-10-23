"use client";

import { DISTRIBUTION_LANGUAGE_NAMES } from "@satsang/distribution-contracts";
import { studioChannelLabel } from "@satsang/distribution-domain";
import { useId, useState } from "react";
import { studioOutputLength, studioOutputState } from "../lib/studio-lineage";
import type { StudioListing, StudioPlaylistPostingCheck } from "../lib/studio-model";
import {
  type PublicStudioPackage,
  type PublicStudioPublication,
  studioMessage,
  studioStatusLabel,
} from "../lib/studio-model";
import {
  STUDIO_POSTING_FILTERS,
  type StudioPostingKey,
  studioPostingState,
} from "../lib/studio-posting-state";
import { type SeriesAction, seriesCandidates, seriesRequest } from "../lib/studio-series-actions";
import {
  studioSourceSkipReasons,
  studioSourceVideo,
  studioSourceWithoutTeaching,
} from "../lib/studio-source-outcome";
import { useHubTimestamp } from "./hub-locale";
import { packageWorkflowStep } from "./studio-progress-summary";
import { StudioSeriesActions } from "./studio-series-actions";
import "./studio-lineage.css";

export function PlaylistFiles({
  packages,
  onOpen,
  onPreview,
  totalRecordings,
  canCurate = false,
  canReview = false,
  canPublish = false,
  showHandoff = true,
  onRefresh,
  workflowStep,
  onClearStep,
  publications = [],
  readiness,
  playlistId,
  sourceLinks = {},
}: {
  packages: readonly PublicStudioPackage[];
  totalRecordings?: number | undefined;
  canCurate?: boolean;
  canReview?: boolean;
  canPublish?: boolean;
  showHandoff?: boolean;
  onRefresh?: () => Promise<void>;
  workflowStep?: number | null;
  onClearStep?: () => void;
  publications?: readonly PublicStudioPublication[];
  readiness?: StudioListing["readiness"] | undefined;
  playlistId?: string | undefined;
  sourceLinks?: Readonly<Record<string, string>> | undefined;
  onOpen: (value: PublicStudioPackage) => void;
  onPreview: (value: PublicStudioPackage, outputId: string) => void;
}) {
  const [channel, setChannel] = useState("all");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [chosenAction, setChosenAction] = useState<SeriesAction | null>(null);
  const selectionScopeId = useId();
  const [postingFilter, setPostingFilter] = useState<StudioPostingKey | "all">("all");
  const [accountChoice, setAccountChoice] = useState("");
  const [channelCheck, setChannelCheck] = useState<StudioPlaylistPostingCheck | null>(null);
  const [checkingChannel, setCheckingChannel] = useState(false);
  const [channelError, setChannelError] = useState("");
  const accounts = readiness?.channels.find((c) => c.channel === "youtube")?.accounts ?? [];
  const account =
    accounts.find((a) => a.id === accountChoice) ??
    accounts.find((a) => a.isDefault) ??
    accounts[0];
  const postingState = (
    pkg: PublicStudioPackage,
    output: PublicStudioPackage["outputs"][number],
  ) => {
    const currentCheck =
      channelCheck?.accountId === account?.id &&
      channelCheck?.playlistId === playlistId &&
      channelCheck?.revisions[pkg.id] === pkg.revision
        ? channelCheck.checks[output.id]
        : undefined;
    return studioPostingState(pkg, output, publications, {
      accountId: output.channel === "youtube" ? account?.id : undefined,
      check: currentCheck && account ? { accountId: account.id, result: currentCheck } : undefined,
    });
  };
  async function checkChannel() {
    if (!playlistId || !account || checkingChannel) return;
    setCheckingChannel(true);
    setChannelError("");
    try {
      const result = await seriesRequest<StudioPlaylistPostingCheck>(
        "/distribution/api/studio/playlist-posting-check",
        { playlistId, accountId: account.id },
        55000,
      );
      setChannelCheck(result);
      if (Object.values(result.checks).some((c) => c.error))
        setChannelError(
          "Channel history is incomplete. No files were sent. Check the connection and try again.",
        );
    } catch {
      setChannelError(studioMessage("STUDIO_POSTING_CHECK_UNAVAILABLE"));
    } finally {
      setCheckingChannel(false);
    }
  }
  const formatTimestamp = useHubTimestamp();
  const outputs = packages.flatMap((value) => value.outputs);
  const channels = [...new Set(outputs.map((output) => output.channel))];
  const groups = packages
    .map((value, index) => ({
      value,
      index,
      shown: value.outputs.filter(
        (output) =>
          (!workflowStep || packageWorkflowStep(value) === workflowStep) &&
          (postingFilter === "all" || postingState(value, output).key === postingFilter) &&
          (channel === "all" || output.channel === channel) &&
          `${value.source.title} ${output.title} ${output.asset?.filename ?? ""}`
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase()),
      ),
    }))
    .filter((group) => group.shown.length);
  const postingCounts = packages
    .flatMap((p) => p.outputs.map((o) => postingState(p, o)))
    .reduce<Record<string, number>>((counts, state) => {
      counts[state.key] = (counts[state.key] ?? 0) + 1;
      return counts;
    }, {});
  const selectable = outputs.filter((o) => o.included);
  const availableActions = (["submit", "approve", "post", "retract"] as const).filter((kind) =>
    kind === "submit" ? canCurate : kind === "approve" ? canReview : canPublish,
  );
  const selectedAction =
    chosenAction && availableActions.includes(chosenAction)
      ? chosenAction
      : (availableActions.find(
          (kind) => kind !== "retract" && seriesCandidates(packages, kind).length,
        ) ??
        availableActions[0] ??
        "submit");
  const recordingSelection = selectedAction === "submit" || selectedAction === "approve";
  function selectionForScope(ids: ReadonlySet<string>, action: SeriesAction) {
    if (action !== "submit" && action !== "approve")
      return new Set(selectable.filter((output) => ids.has(output.id)).map((output) => output.id));
    return new Set(
      packages
        .filter((pkg) => pkg.outputs.some((output) => output.included && ids.has(output.id)))
        .flatMap((pkg) =>
          pkg.outputs.filter((output) => output.included).map((output) => output.id),
        ),
    );
  }
  const selected = selectionForScope(selection, selectedAction);
  function chooseAction(action: SeriesAction) {
    setChosenAction(action);
    setSelection(selectionForScope(selected, action));
  }
  function selectFiles(ids: readonly string[], checked: boolean) {
    const affected = selectionForScope(new Set(ids), selectedAction);
    const next = new Set(selected);
    for (const id of affected) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    setSelection(next);
  }
  const visibleIds = groups.flatMap((g) => g.shown.filter((o) => o.included).map((o) => o.id));
  const canSelect = Boolean(onRefresh && (canCurate || canReview || canPublish));
  const skipped = packages.filter(studioSourceWithoutTeaching);
  const waiting = packages.filter((value) => !value.outputs.length && !skipped.includes(value));
  const includedCount = (value: PublicStudioPackage) =>
    value.outputs.filter((o) => o.included).length;
  const drafts = packages.filter((value) => value.status === "DRAFT" && includedCount(value));
  const submitted = packages.filter(
    (value) => value.status === "IN_REVIEW" && includedCount(value),
  );
  const nextReview = canReview ? submitted[0] : undefined;
  const nextDraft = canCurate ? drafts[0] : undefined;
  const actionLabel = (value: PublicStudioPackage) => {
    if (value.status === "DRAFT")
      return canCurate ? "Check & submit" : canReview ? "Preview draft" : "Open workflow";
    if (value.status === "IN_REVIEW" && canReview) return "Review & approve";
    if (value.status === "APPROVED" && canPublish) return "Open publishing";
    if (value.status === "CHANGES_REQUESTED" && canCurate) return "Fix & resubmit";
    return "Open workflow";
  };
  return (
    <section className="studio-lineage" aria-label="All bundle files">
      <div className="series-files-heading">
        <h3>Series files</h3>
        <p>
          {outputs.length} files across {packages.length} recordings
          {channels
            .map(
              (name) =>
                ` · ${studioChannelLabel(name)}: ${outputs.filter((output) => output.channel === name).length}`,
            )
            .join("")}
        </p>
      </div>
      {showHandoff && (canCurate || canReview) && (drafts.length > 0 || submitted.length > 0) && (
        <section className="panel" aria-label="Review handoff" style={{ marginBlock: 16 }}>
          <h4>Next action</h4>
          <p>
            {drafts.reduce((count, value) => count + includedCount(value), 0)} files awaiting
            Curator submission ·{" "}
            {submitted.reduce((count, value) => count + includedCount(value), 0)} files ready for
            Approver review.
          </p>
          {canReview && !canCurate && drafts.length > 0 && (
            <p>
              Drafts must first be checked and submitted by the Curator using
              <strong> Submit All</strong> or <strong>Submit Selected</strong> above the file list.
              Approval controls become available after submission.
            </p>
          )}
          <p>
            Review and approval apply to each recording’s included files. Posting is a separate
            action after approval.
          </p>
          {packages.length > 0 && packages.every((value) => value.isTest) && (
            <p>
              <strong>Test workspace:</strong> publication is simulated; no videos are posted to
              YouTube.
            </p>
          )}
          {nextReview ? (
            <button type="button" className="button primary" onClick={() => onOpen(nextReview)}>
              Review next recording
            </button>
          ) : nextDraft ? (
            <button type="button" className="button primary" onClick={() => onOpen(nextDraft)}>
              Check &amp; submit next recording
            </button>
          ) : null}
        </section>
      )}
      {totalRecordings !== undefined && totalRecordings > packages.length && (
        <p>
          This bundle contains {totalRecordings} recordings. Another{" "}
          {totalRecordings - packages.length} are downloading or waiting to enter curation. Their
          files will appear here automatically.
        </p>
      )}
      {workflowStep && (
        <p className="active-filter">
          Showing step {workflowStep}{" "}
          <button type="button" className="button" onClick={onClearStep}>
            Clear stage filter
          </button>
        </p>
      )}
      <div className="posting-overview" aria-label="Posting overview">
        <p>
          <strong>{postingCounts.posted ?? 0} posted through Studio</strong> ·{" "}
          {postingCounts.queued ?? 0} queued · {postingCounts.not_posted ?? 0} without a Studio
          posting record
          {postingCounts.attention ? ` · ${postingCounts.attention} need attention` : ""}
          {postingCounts.earlier_version
            ? ` · ${postingCounts.earlier_version} earlier versions posted`
            : ""}
          {postingCounts.simulated ? ` · ${postingCounts.simulated} simulated` : ""}
          {postingCounts.cancelled ? ` · ${postingCounts.cancelled} cancelled` : ""}
        </p>
        <details className="channel-check-details">
          <summary>
            {account
              ? `YouTube · ${account.label} — check channel uploads`
              : "About posting records"}
          </summary>
          {account && (
            <div className="posting-account-controls">
              <label>
                YouTube account
                <select
                  aria-label="Posting status account"
                  value={account.id}
                  disabled={checkingChannel}
                  onChange={(event) => {
                    setAccountChoice(event.target.value);
                    setChannelError("");
                  }}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                      {a.isDefault ? " · Default" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {playlistId && (
                <button
                  className="button"
                  type="button"
                  disabled={checkingChannel || account.connectionPending}
                  onClick={() => void checkChannel()}
                >
                  {checkingChannel ? "Checking YouTube…" : "Check YouTube for existing posts"}
                </button>
              )}
              {account.channelUrl && (
                <a href={account.channelUrl} target="_blank" rel="noreferrer">
                  Open channel ↗
                </a>
              )}
            </div>
          )}
          <p className="muted">
            Studio records and channel uploads are separate. The check compares Buffer-synced
            YouTube history; it may miss recent, private or renamed uploads.
          </p>
          {channelCheck && channelCheck.accountId === account?.id && (
            <p className="muted">Last checked {formatTimestamp(channelCheck.checkedAt)}</p>
          )}
          {channelError && <p role="alert">{channelError}</p>}
        </details>
      </div>
      <div className="file-list-controls">
        <div className="lineage-filters">
          {channels.length > 1 && (
            <label>
              <span className="visually-hidden">Channel</span>
              <select
                aria-label="Playlist file channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="all">All channels ({outputs.length})</option>
                {channels.map((name) => (
                  <option key={name} value={name}>
                    {studioChannelLabel(name)} (
                    {outputs.filter((output) => output.channel === name).length})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="visually-hidden">Posting status</span>
            <select
              aria-label="Posting status filter"
              value={postingFilter}
              onChange={(event) => setPostingFilter(event.target.value as StudioPostingKey | "all")}
            >
              {STUDIO_POSTING_FILTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                  {item.value === "all" ? "" : ` (${postingCounts[item.value] ?? 0})`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Search files</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, filename or recording"
            />
          </label>
          <output>
            {groups.reduce((count, group) => count + group.shown.length, 0)} of {outputs.length}{" "}
            files
          </output>
        </div>
        {onRefresh && (
          <StudioSeriesActions
            packages={packages}
            canCurate={canCurate}
            canReview={canReview}
            canPublish={canPublish}
            onRefresh={onRefresh}
            onPreview={onPreview}
            selectedOutputIds={selected}
            selectedAction={selectedAction}
            onActionChange={chooseAction}
          />
        )}
      </div>
      {canSelect && (
        <div className="file-selection-summary">
          <span id={selectionScopeId}>
            {recordingSelection
              ? "Selecting a file selects its recording’s complete set of included files for submission or approval."
              : "Select individual files for posting or retraction."}
          </span>
          <span>“All” includes every eligible file in this series, even outside the filters.</span>
          {selected.size > 0 && (
            <button type="button" className="button" onClick={() => setSelection(new Set())}>
              Clear selection
            </button>
          )}
        </div>
      )}
      <section
        className="lineage-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A labeled scroll region must be keyboard-scrollable.
        tabIndex={0}
        aria-label="Playlist files table"
      >
        <table className="lineage-table playlist-files-table">
          <caption className="visually-hidden">
            Generated files from every recording in this bundle
          </caption>
          <thead>
            <tr>
              {canSelect && (
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select all visible files"
                    aria-describedby={selectionScopeId}
                    checked={visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))}
                    disabled={!visibleIds.length}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          visibleIds.some((id) => selected.has(id)) &&
                          !visibleIds.every((id) => selected.has(id));
                    }}
                    onChange={(event) => selectFiles(visibleIds, event.target.checked)}
                  />
                </th>
              )}
              <th scope="col">Master recording</th>
              <th scope="col">File / preview</th>
              <th scope="col">Channel</th>
              <th scope="col">Type / language</th>
              <th scope="col">Length</th>
              <th scope="col">Version / generated</th>
              <th scope="col">Review status</th>
              <th scope="col">Posting status</th>
            </tr>
          </thead>
          {groups.map(({ value, index, shown }) => (
            <tbody key={value.id}>
              {shown.map((output, row) => {
                const status = studioOutputState(value, output, []);
                const posting = postingState(value, output);
                const generatedAt = output.generatedAt ?? value.provenance?.generatedAt;
                return (
                  <tr
                    key={output.id}
                    data-included={output.included}
                    data-selected={selected.has(output.id)}
                  >
                    {canSelect && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${output.title}`}
                          aria-describedby={selectionScopeId}
                          disabled={!output.included}
                          checked={selected.has(output.id)}
                          onChange={(event) => selectFiles([output.id], event.target.checked)}
                        />
                      </td>
                    )}
                    {row === 0 && (
                      <th scope="rowgroup" rowSpan={shown.length} className="playlist-file-master">
                        <span>
                          {index + 1}. {value.source.title}
                        </span>
                        <small>{value.outputs.length} files</small>
                        <button
                          className="button"
                          type="button"
                          onClick={() => onOpen(value)}
                          aria-label={`Open workflow for ${value.source.title}`}
                        >
                          {actionLabel(value)}
                        </button>
                      </th>
                    )}
                    <th scope="row" className="lineage-file">
                      <button
                        type="button"
                        aria-label={`Preview ${output.asset?.filename ?? output.title}`}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          onPreview(value, output.id);
                        }}
                      >
                        {output.title}
                      </button>
                      <details className="file-metadata">
                        <summary>Filename</summary>
                        <small>{output.asset?.filename ?? output.title}</small>
                      </details>
                    </th>
                    <td>{studioChannelLabel(output.channel)}</td>
                    <td>
                      {output.format}
                      <small>{DISTRIBUTION_LANGUAGE_NAMES[output.language]}</small>
                    </td>
                    <td>{studioOutputLength(output).label}</td>
                    <td>
                      v{output.fileVersion ?? 1}
                      {generatedAt && (
                        <small>
                          <time dateTime={generatedAt}>{formatTimestamp(generatedAt)}</time>
                        </small>
                      )}
                    </td>
                    <td>
                      <span className={`lineage-status lineage-status-${status.tone}`}>
                        {status.label}
                      </span>
                      {output.correction && <small>{output.correction.comment}</small>}
                    </td>
                    <td>
                      <span className={`lineage-status lineage-status-${posting.tone}`}>
                        {posting.label}
                      </span>
                      {posting.url && (
                        <a href={posting.url} target="_blank" rel="noreferrer">
                          {posting.key === "posted" || posting.key === "earlier_version"
                            ? "View posted video ↗"
                            : "Check channel video ↗"}
                        </a>
                      )}
                      <details className="file-metadata">
                        <summary>Details</summary>
                        <small>{posting.detail}</small>
                        {posting.postedAt && (
                          <time dateTime={posting.postedAt}>
                            {formatTimestamp(posting.postedAt)}
                          </time>
                        )}
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </section>
      {!groups.length && (
        <p>
          {outputs.length
            ? "No files match these filters."
            : waiting.length
              ? "Files will appear here as generation finishes."
              : "No files were selected from these source recordings."}
        </p>
      )}
      {skipped.length > 0 && (
        <details>
          <summary>
            {skipped.length} {skipped.length === 1 ? "source recording" : "source recordings"} with
            no generated files
          </summary>
          <p>
            These decisions apply only to the source recordings below. Files from other recordings,
            including recordings with the same title, are unchanged.
          </p>
          <ul>
            {skipped.map((value) => {
              const source = studioSourceVideo(sourceLinks[value.source.masterId]);
              const reasons = studioSourceSkipReasons(value);
              const other = packages.filter(
                (candidate) =>
                  candidate.source.masterId !== value.source.masterId &&
                  candidate.source.title === value.source.title &&
                  candidate.outputs.length > 0,
              );
              return (
                <li key={value.id} className="source-outcome">
                  <strong>{value.source.title}</strong>
                  {source && (
                    <p>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        Original video · {source.id}
                      </a>
                    </p>
                  )}
                  <p>
                    {reasons.join(" ") ||
                      "The AI did not select a complete teaching from this recording in this attempt. Open the source review for its evidence."}
                  </p>
                  <button type="button" className="button" onClick={() => onOpen(value)}>
                    Review this source
                  </button>
                  {other.map((candidate) => (
                    <p key={candidate.id}>
                      A different recording with this title has {candidate.outputs.length}{" "}
                      {candidate.outputs.length === 1 ? "file" : "files"}.{" "}
                      <button type="button" className="button" onClick={() => onOpen(candidate)}>
                        View existing {candidate.outputs.length === 1 ? "file" : "files"}
                      </button>
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {waiting.length > 0 && (
        <details>
          <summary>{waiting.length} recordings still need generated files</summary>
          <ul>
            {waiting.map((value) => (
              <li key={value.id}>
                {value.source.title} · {studioStatusLabel(value)}{" "}
                <button type="button" className="button" onClick={() => onOpen(value)}>
                  Open workflow
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
