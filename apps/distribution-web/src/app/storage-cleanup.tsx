"use client";
import type { CleanupPreview, CleanupSelection } from "@satsang/distribution-domain";
import { useId, useState } from "react";
const storageSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export function StorageCleanup({
  kind,
  id,
  onDeleted,
}: { kind: CleanupSelection["kind"]; id: string; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CleanupSelection["mode"]>(
    kind === "package" ? "generated" : "all",
  );
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const statusId = useId();
  const blocked = Boolean(preview?.blockers.length);
  const needsApprover = preview?.blockers.some((reason) => reason.includes("Content Approver"));
  async function send(remove = false, selectedMode = mode) {
    if (busy || (remove && (!preview || blocked))) return;
    setBusy(true);
    setError("");
    if (!remove) setPreview(null);
    try {
      const response = await fetch("/distribution/api/storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          remove
            ? {
                action: "delete",
                selection: { kind, id, mode: selectedMode },
                token: preview?.token,
                confirmed: true,
              }
            : { action: "preview", selection: { kind, id, mode: selectedMode } },
        ),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? "Unable to prepare cleanup.");
      if (remove) {
        setDone(true);
        setPreview(null);
      } else setPreview(data.preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to prepare cleanup.");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="storage-cleanup">
      {!open ? (
        <button
          type="button"
          className="button"
          onClick={() => {
            setOpen(true);
            void send();
          }}
        >
          Delete {kind}…
        </button>
      ) : (
        <section className="panel" aria-label="Manage storage">
          <h3>Free up storage</h3>
          {done ? (
            <>
              <output>
                Cleanup queued. The selected content is removed from the workspace; file deletion
                continues in the background. Review history is retained.
              </output>
              <a href="/distribution/storage">View cleanup progress</a>
              <button
                className="button"
                type="button"
                onClick={() =>
                  onDeleted ? onDeleted() : window.location.assign("/distribution?view=studio")
                }
              >
                Back to workspace
              </button>
            </>
          ) : (
            <>
              <p>
                Delete stored media permanently. Posts already published on social channels are
                unaffected.
              </p>
              {kind !== "package" && (
                <label>
                  What would you like to remove?
                  <select
                    value={mode}
                    disabled={busy}
                    onChange={(e) => {
                      const nextMode = e.target.value as CleanupSelection["mode"];
                      setMode(nextMode);
                      void send(false, nextMode);
                    }}
                  >
                    <option value="generated">Generated packages only — keep masters</option>
                    <option value="all">
                      {kind === "playlist"
                        ? "Entire playlist, masters and packages"
                        : "Master and all its packages"}
                    </option>
                  </select>
                </label>
              )}
              {kind === "package" && (
                <p>This removes this package’s generated files and keeps its master.</p>
              )}
              <div id={statusId} aria-live="polite">
                {busy && <output>{preview ? "Queuing deletion…" : "Checking cleanup…"}</output>}
                {error && <p role="alert">{error}</p>}
                {blocked && (
                  <div className="notice error" role="alert">
                    <strong>
                      {needsApprover ? "Content Approver required" : "Deletion is blocked"}
                    </strong>
                    <ul>
                      {preview?.blockers.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    {needsApprover && (
                      <p>
                        Your current account cannot delete this selection. Sign in with a Content
                        Approver account and open this source again.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {preview && (
                <div aria-live="polite">
                  <strong>{preview.title}</strong>
                  <p>
                    {preview.masterCount} masters · {preview.packageCount} packages ·{" "}
                    {preview.fileCount} files · approximately {storageSize(preview.bytes)} to
                    reclaim
                  </p>
                  {preview.sharedFileCount > 0 && (
                    <p>
                      {preview.sharedFileCount} shared files will be kept because other content uses
                      them.
                    </p>
                  )}
                  <p>
                    The files cannot be restored after deletion. The small audit and review records
                    will remain.
                  </p>
                </div>
              )}
              <div className="actions wrap">
                <button
                  type="button"
                  className="button danger"
                  disabled={busy || !preview || blocked}
                  aria-describedby={statusId}
                  onClick={() => void send(true)}
                >
                  Permanently delete selected files
                </button>
                {(blocked || error) && (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => void send()}
                  >
                    Check again
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    setPreview(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
