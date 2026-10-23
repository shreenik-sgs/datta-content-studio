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

export function StudioSeriesActions({
  packages,
  canCurate,
  canReview,
  canPublish,
  onRefresh,
  onPreview,
}: {
  packages: readonly PublicStudioPackage[];
  canCurate: boolean;
  canReview: boolean;
  canPublish: boolean;
  onRefresh: () => Promise<void>;
  onPreview: (pkg: PublicStudioPackage, outputId: string) => void;
}) {
  const [action, setAction] = useState<SeriesAction | null>(null);
  const [rows, setRows] = useState<SeriesRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<SeriesResult[]>([]);
  const [finished, setFinished] = useState(false);
  const [accounts, setAccounts] = useState<Partial<Record<StudioChannel, string>>>({});
  const locked = useRef(false);
  const panel = useRef<HTMLElement>(null);
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
  const chosen = rows.filter((row) => selected.has(row.id) && !row.blocker);
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
  const sourceApprovalNeeded =
    action === "approve" && chosen.some((row) => row.source?.state === "RIGHTS_CLEARED");
  async function prepare(kind: SeriesAction, all: boolean) {
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
    setSelected(new Set());
    setAccounts({});
    try {
      const prepared = await prepareSeriesRows(packages, kind);
      setRows(prepared);
      setSelected(new Set(all ? prepared.filter((r) => !r.blocker).map((r) => r.id) : []));
    } catch (e) {
      setError(
        e instanceof Error && e.message === "STUDIO_SERIES_LOAD_FAILED"
          ? "Could not load the whole selection. No action was taken. Retry after the connection recovers."
          : studioMessage(e instanceof Error ? e.message : "unavailable"),
      );
    } finally {
      setBusy(false);
      locked.current = false;
      panel.current?.focus();
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
    <section className="panel" aria-label="Series actions" style={{ marginBlock: 20 }}>
      <h3>Series actions</h3>
      <p>Submit and approve selected recordings together. Post or retract individual Shorts.</p>
      {isTest && (
        <p>
          <strong>
            Test workspace: posting and retraction are simulations. No external videos are posted or
            removed.
          </strong>
        </p>
      )}
      <div className="actions wrap">
        {available.map((kind) => (
          <div
            key={kind}
            className="actions wrap"
            style={{
              border: "1px solid var(--border, #ddd)",
              borderRadius: 10,
              padding: 8,
              marginTop: 0,
            }}
          >
            <button
              className="button"
              type="button"
              disabled={busy || (kind !== "retract" && !seriesCandidates(packages, kind).length)}
              onClick={() => void prepare(kind, true)}
            >
              {seriesActionName[kind]} All
            </button>
            <button
              className="button"
              type="button"
              disabled={busy || (kind !== "retract" && !seriesCandidates(packages, kind).length)}
              onClick={() => void prepare(kind, false)}
            >
              {seriesActionName[kind]} Selected
            </button>
          </div>
        ))}
      </div>
      {canReview && !seriesCandidates(packages, "approve").length && (
        <p>
          No recordings await approval. The Curator must submit them first using Submit All or
          Submit Selected.
        </p>
      )}
      {canPublish && !seriesCandidates(packages, "post").length && (
        <p>Post becomes available after approval.</p>
      )}
      {action && (
        <section
          ref={panel}
          tabIndex={-1}
          aria-label={`${seriesActionName[action]} selection`}
          style={{ marginTop: 20 }}
        >
          <h4>
            {seriesActionName[action]} · {count} files in{" "}
            {new Set(chosen.map((r) => r.detail.package.id)).size} recordings selected
          </h4>
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
                ? "No posting requests exist for this series. Drafts have not been posted."
                : "No recordings are ready for this action."}
            </p>
          )}
          {rows.length > 0 && (
            <>
              <p>
                {rows.filter((r) => r.blocker).length} blocked selections. Blocked items are
                excluded; see the reason beside each one.
              </p>
              {action === "retract" && (
                <p>
                  Queued posts can be cancelled. Published YouTube videos require removal in YouTube
                  Studio because Buffer cannot delete them from YouTube. Sending or uncertain posts
                  remain unconfirmed. Retraction never deletes local files or approvals.
                </p>
              )}
              <fieldset disabled={busy || finished} style={{ border: 0, padding: 0 }}>
                <legend>
                  {action === "submit" || action === "approve"
                    ? "Choose recordings (all included files in each)"
                    : "Choose individual files"}
                </legend>
                <div className="actions wrap">
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setSelected(new Set(rows.filter((r) => !r.blocker).map((r) => r.id)));
                      setConfirmed(false);
                    }}
                  >
                    Select all eligible
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setSelected(new Set());
                      setConfirmed(false);
                    }}
                  >
                    Clear selection
                  </button>
                </div>
                <div style={{ maxHeight: 420, overflow: "auto", marginBlock: 12 }}>
                  {rows.map((row) => (
                    <div
                      key={row.id}
                      style={{ borderBottom: "1px solid #ddd", padding: "12px 4px" }}
                    >
                      <label style={{ display: "flex", gap: 12, alignItems: "start" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          disabled={Boolean(row.blocker)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            setSelected(next);
                            setConfirmed(false);
                            setRightsConfirmed(false);
                          }}
                        />
                        <span>
                          {row.title} · {row.count} {row.count === 1 ? "file" : "files"}
                          {row.publication ? ` · ${row.publication.status}` : ""}
                        </span>
                      </label>
                      {row.blocker && <p>{row.blocker}</p>}
                      <details>
                        <summary>
                          {row.source ? "Files and master permissions" : "Preview files"}
                        </summary>
                        <ul>
                          {row.detail.package.outputs
                            .filter(
                              (o) =>
                                o.included &&
                                (!row.outputId || o.id === row.outputId) &&
                                (!row.publication || o.id === row.publication.outputId),
                            )
                            .map((o) => (
                              <li key={o.id}>
                                <button
                                  type="button"
                                  className="button"
                                  onClick={() => onPreview(row.detail.package, o.id)}
                                >
                                  {o.title}
                                </button>
                              </li>
                            ))}
                        </ul>
                        {row.source && (
                          <p>
                            Rights holder: {row.source.rights?.owner ?? "Missing"}
                            <br />
                            Authorization: {row.source.rights?.authorizationBasis ?? "Missing"}
                            <br />
                            Channels: {row.source.rights?.channels.join(", ")}
                            <br />
                            Territories: {row.source.rights?.territories.join(", ")}
                            <br />
                            Visibility: {row.source.rights?.privacyClass}
                            <br />
                            Release: {row.source.rights?.releaseAt ?? "Immediate"} · Expiry:{" "}
                            {row.source.rights?.expiresAt ?? "None"}
                          </p>
                        )}
                      </details>
                    </div>
                  ))}
                </div>
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
                    ? "I checked the included files and want to send this selection for review."
                    : action === "approve"
                      ? "I reviewed the native transcript, translations, subtitles and complete teachings for every selected recording and approve these files."
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
                  Confirm {seriesActionName[action].toLowerCase()} · {count} files
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
            </section>
          )}
          {!busy && (
            <button type="button" className="button" onClick={() => setAction(null)}>
              Close selection
            </button>
          )}
        </section>
      )}
    </section>
  );
}
