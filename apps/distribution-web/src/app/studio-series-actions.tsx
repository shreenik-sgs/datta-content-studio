"use client";
import { type StudioChannel, studioChannelLabel } from "@satsang/distribution-domain";
import { useEffect, useRef, useState } from "react";
import { type PublicStudioPackage, studioMessage } from "../lib/studio-model";
import {
  type SeriesAction,
  type SeriesResult,
  type SeriesRow,
  prepareSeriesRows,
  runSeriesAction,
  seriesActionName,
  seriesCandidates,
} from "../lib/studio-series-actions";
import { StudioActionDialog } from "./studio-action-dialog";

export function StudioSeriesActions({
  packages,
  canCurate,
  canReview,
  canPublish,
  onRefresh,
  selectedOutputIds,
  selectedAction,
  onActionChange,
}: {
  packages: readonly PublicStudioPackage[];
  canCurate: boolean;
  canReview: boolean;
  canPublish: boolean;
  onRefresh: () => Promise<void>;
  selectedOutputIds: ReadonlySet<string>;
  selectedAction?: SeriesAction;
  onActionChange?: (action: SeriesAction) => void;
}) {
  const [action, setAction] = useState<SeriesAction | null>(null);
  const [rows, setRows] = useState<SeriesRow[]>([]);
  const [requestedCount, setRequestedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<SeriesResult[]>([]);
  const [finished, setFinished] = useState(false);
  const [accounts, setAccounts] = useState<Partial<Record<StudioChannel, string>>>({});
  const locked = useRef(false);
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);
  const permitted = (kind: SeriesAction) =>
    kind === "submit" ? canCurate : kind === "approve" ? canReview : canPublish;
  const available = (["submit", "approve", "post", "retract"] as const).filter(permitted);
  const [chosenAction, setChosenAction] = useState<SeriesAction | null>(null);
  const requestedAction = selectedAction ?? chosenAction;
  const toolbarAction =
    requestedAction && available.includes(requestedAction)
      ? requestedAction
      : (available.find((kind) => kind !== "retract" && seriesCandidates(packages, kind).length) ??
        available[0] ??
        "submit");
  const eligible = seriesCandidates(packages, toolbarAction).filter((pkg) =>
    pkg.outputs.some((output) => selectedOutputIds.has(output.id)),
  );
  const chosen = rows.filter((row) => !row.blocker);
  const blocked = rows.filter((row) => row.blocker);
  const unavailableCount = Math.max(0, requestedCount - rows.reduce((n, row) => n + row.count, 0));
  const count = chosen.reduce((n, row) => n + row.count, 0);
  const channels = [
    ...new Set(
      chosen.flatMap((r) =>
        r.detail.package.outputs.filter((o) => o.id === r.outputId).map((o) => o.channel),
      ),
    ),
  ];
  const readiness = rows[0]?.detail.readiness;
  const isTest = packages.every((p) => p.isTest);
  const targets = channels.map((channel) => {
    const connection = readiness?.channels.find((c) => c.channel === channel);
    const id = accounts[channel] ?? connection?.accounts?.find((a) => a.isDefault)?.id;
    const account = connection?.accounts?.find((a) => a.id === id);
    return { channel, connection, id, account };
  });
  const targetBlocked =
    action === "post" &&
    targets.some(
      ({ connection, account }) =>
        (connection?.accounts?.length && (!account || account.connectionPending)) ||
        (!isTest && !(account?.ready ?? connection?.ready)),
    );
  const sourcesToApprove = [
    ...new Map(
      chosen
        .filter((row) => row.source?.state === "RIGHTS_CLEARED")
        .map((row) => [row.source?.id, row]),
    ).values(),
  ];
  const sourceApprovalNeeded = action === "approve" && sourcesToApprove.length > 0;
  async function prepare(kind: SeriesAction) {
    if (locked.current || !permitted(kind)) return;
    locked.current = true;
    setBusy(true);
    setAction(kind);
    setError("");
    setResults([]);
    setFinished(false);
    setConfirmed(false);
    setRightsConfirmed(false);
    setRows([]);
    setRequestedCount(selectedOutputIds.size);
    setAccounts({});
    try {
      const selectedIds = new Set(selectedOutputIds);
      const candidates = packages.filter((p) => p.outputs.some((o) => selectedIds.has(o.id)));
      const prepared = await prepareSeriesRows(candidates, kind);
      setRows(
        prepared
          .filter((row) =>
            row.outputId
              ? selectedIds.has(row.outputId)
              : row.publication
                ? selectedIds.has(row.publication.outputId)
                : row.detail.package.outputs.some((o) => selectedIds.has(o.id)),
          )
          .map((row) => ({
            ...row,
            blocker:
              candidates.find((pkg) => pkg.id === row.detail.package.id)?.revision !==
              row.detail.package.revision
                ? "This recording changed after selection. Refresh the file list and review it again."
                : row.blocker,
          })),
      );
    } catch (e) {
      setError(
        e instanceof Error && e.message === "STUDIO_SERIES_LOAD_FAILED"
          ? "Could not load the whole selection. No action was taken. Retry after the connection recovers."
          : studioMessage(e instanceof Error ? e.message : "unavailable"),
      );
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }
  async function execute() {
    if (
      locked.current ||
      !action ||
      !permitted(action) ||
      !chosen.length ||
      !confirmed ||
      targetBlocked ||
      (sourceApprovalNeeded && !rightsConfirmed) ||
      finished
    )
      return;
    locked.current = true;
    setBusy(true);
    setRunning(true);
    setError("");
    setResults([]);
    try {
      await runSeriesAction(
        action,
        chosen,
        Object.fromEntries(targets.filter((t) => t.id).map((t) => [t.channel, t.id])),
        (result) => setResults((previous) => [...previous, result]),
      );
    } catch (e) {
      setError(studioMessage(e instanceof Error ? e.message : "STUDIO_ACTION_UNCONFIRMED"));
    } finally {
      setFinished(true);
      setRunning(false);
      setBusy(false);
      locked.current = false;
      await onRefresh().catch(() =>
        setError(
          "Results are shown below, but the file list could not refresh. Reload before starting another action.",
        ),
      );
    }
  }
  if (!available.length) return null;
  return (
    <div className="file-action-toolbar" aria-label="File actions">
      <div className="file-action-buttons">
        <label>
          <span className="visually-hidden">Action</span>
          <select
            aria-label="File action"
            value={toolbarAction}
            disabled={busy || Boolean(action)}
            onChange={(event) => {
              const nextAction = event.target.value as SeriesAction;
              setChosenAction(nextAction);
              onActionChange?.(nextAction);
            }}
          >
            {available.map((kind) => (
              <option key={kind} value={kind}>
                {seriesActionName[kind]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          type="button"
          disabled={busy || Boolean(action) || !eligible.length || !selectedOutputIds.size}
          onClick={() => void prepare(toolbarAction)}
        >
          {seriesActionName[toolbarAction]} Selected
        </button>
        <span aria-live="polite">
          {selectedOutputIds.size} {selectedOutputIds.size === 1 ? "file" : "files"} selected
        </span>
      </div>
      {isTest && (
        <p className="muted">
          Test workspace · Posting is simulated. Nothing is sent to or removed from YouTube.
        </p>
      )}
      {toolbarAction === "approve" && !eligible.length && (
        <p>Select submitted files to approve. Drafts must first be submitted by the Curator.</p>
      )}
      {toolbarAction === "post" && !eligible.length && <p>Select approved files to post.</p>}
      {action && (
        <StudioActionDialog
          title={`${seriesActionName[action]} selected files`}
          busy={busy}
          onClose={() => setAction(null)}
          closeLabel={finished ? "Back to files" : "Cancel"}
        >
          {!busy && rows.length > 0 && (
            <p className="action-selection-count">
              <strong>
                {count} {count === 1 ? "file" : "files"}
              </strong>{" "}
              in {new Set(chosen.map((r) => r.detail.package.id)).size}{" "}
              {new Set(chosen.map((r) => r.detail.package.id)).size === 1
                ? "recording"
                : "recordings"}{" "}
              ready
            </p>
          )}
          {(action === "submit" || action === "approve") && (
            <p className="muted">
              Applies only to the selected files. Other files stay unchanged.
              {action === "approve" ? " Approval does not post anything." : ""}
            </p>
          )}
          {busy && (
            <output>
              {running
                ? `Processing selection… ${results.length} results received. Keep this page open.`
                : "Checking current states and permissions…"}
            </output>
          )}
          {error && <p role="alert">{error}</p>}
          {!busy && !rows.length && !error && (
            <p>
              {action === "retract"
                ? "No posting requests exist in Studio for this series. Check the channel for videos uploaded outside Studio."
                : "No selected files are ready for this action."}
            </p>
          )}
          {!busy && !error && unavailableCount > 0 && (
            <output>
              {unavailableCount} selected files are no longer eligible for this action. They will
              not be changed.
            </output>
          )}
          {rows.length > 0 && (
            <>
              {blocked.length > 0 && (
                <details className="action-review-details" open>
                  <summary>
                    {blocked.reduce((n, row) => n + row.count, 0)} files cannot proceed
                  </summary>
                  <ul>
                    {blocked.map((row) => (
                      <li key={row.id}>
                        <strong>{row.title}</strong>: {row.blocker}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {action === "retract" && (
                <p>
                  Queued posts can be cancelled. Published YouTube videos require removal in YouTube
                  Studio because Buffer cannot delete them from YouTube. Sending or uncertain posts
                  remain unconfirmed. Retraction never deletes local files or approvals.
                </p>
              )}
              <fieldset disabled={busy || finished} style={{ border: 0, padding: 0 }}>
                <legend className="visually-hidden">Confirm selection</legend>
                {sourceApprovalNeeded && (
                  <details className="action-review-details">
                    <summary>
                      Review master permissions for {sourcesToApprove.length} recordings
                    </summary>
                    <ul>
                      {sourcesToApprove.map((row) => (
                        <li key={row.id}>
                          <strong>{row.title}</strong>
                          <p>
                            Rights holder: {row.source?.rights?.owner ?? "Missing"}
                            <br />
                            Authorization: {row.source?.rights?.authorizationBasis ?? "Missing"}
                            <br />
                            Channels: {row.source?.rights?.channels.join(", ")}
                            <br />
                            Territories: {row.source?.rights?.territories.join(", ")}
                            <br />
                            Visibility: {row.source?.rights?.privacyClass}
                            <br />
                            Release: {row.source?.rights?.releaseAt ?? "Immediate"} · Expiry:{" "}
                            {row.source?.rights?.expiresAt ?? "None"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {action === "post" &&
                  targets.map(({ channel, connection, account, id }) => (
                    <div key={channel}>
                      <label>
                        {studioChannelLabel(channel)} destination
                        <select
                          value={id ?? ""}
                          onChange={(e) => {
                            setAccounts((old) => ({ ...old, [channel]: e.target.value }));
                            setConfirmed(false);
                          }}
                        >
                          {!id && (
                            <option value="">
                              {isTest && !connection?.accounts?.length
                                ? "Simulation only"
                                : "Choose account"}
                            </option>
                          )}
                          {connection?.accounts?.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                              {a.isDefault ? " · Default" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      {account?.channelUrl && (
                        <p>
                          Destination: {account.channelUrl} · Visibility:{" "}
                          {account.privacy ?? "Channel default"}
                        </p>
                      )}
                      {!isTest && !(account?.ready ?? connection?.ready) && (
                        <p>
                          {studioMessage(
                            account?.reason ?? connection?.reason ?? "CHANNEL_NOT_CONNECTED",
                          )}
                        </p>
                      )}
                      {account?.connectionPending && (
                        <p>This destination needs an Admin to finish connecting it.</p>
                      )}
                    </div>
                  ))}
                {sourceApprovalNeeded && (
                  <label style={{ display: "block", marginBlock: 12 }}>
                    <input
                      type="checkbox"
                      checked={rightsConfirmed}
                      onChange={(e) => setRightsConfirmed(e.target.checked)}
                    />{" "}
                    I reviewed the listed master permissions and approve them for the selected
                    recordings.
                  </label>
                )}
                <label style={{ display: "block", marginBlock: 12 }}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{" "}
                  {action === "submit"
                    ? "I checked the selected files and want to send this selection for review."
                    : action === "approve"
                      ? "I reviewed the native transcript, translations, subtitles and complete teachings for every selected file and approve these files."
                      : action === "post"
                        ? "I confirm this file selection and destination. Each file must pass the duplicate check before sending."
                        : "I want to retract this selection. I understand already published videos may need removal on the channel."}
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !count ||
                    !confirmed ||
                    Boolean(targetBlocked) ||
                    (sourceApprovalNeeded && !rightsConfirmed)
                  }
                  onClick={() => void execute()}
                >
                  Confirm {seriesActionName[action].toLowerCase()} · {count}{" "}
                  {count === 1 ? "file" : "files"}
                  {isTest && (action === "post" || action === "retract") ? " (test)" : ""}
                </button>
              </fieldset>
            </>
          )}
          {results.length > 0 && (
            <section aria-label="Series action results" aria-live="polite">
              <h4>
                {results.filter((r) => r.ok).length} successful ·{" "}
                {results.filter((r) => !r.ok).length} need attention
                {finished && results.length < chosen.length
                  ? ` · ${chosen.length - results.length} not attempted`
                  : ""}
              </h4>
              <details className="action-review-details">
                <summary>See results</summary>
                <ul>
                  {results.map((result) => (
                    <li key={result.id}>
                      <strong>{result.title}</strong>: {result.message}
                      {result.remoteUrl && (
                        <>
                          {" "}
                          <a href={result.remoteUrl} target="_blank" rel="noreferrer">
                            View channel post
                          </a>
                        </>
                      )}
                      {!result.ok && action === "retract" && result.channel === "youtube" && (
                        <>
                          {" "}
                          <a href="https://studio.youtube.com" target="_blank" rel="noreferrer">
                            Open YouTube Studio
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}
        </StudioActionDialog>
      )}
    </div>
  );
}
