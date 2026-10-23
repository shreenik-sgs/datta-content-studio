"use client";
import type { PostingCheck } from "@satsang/distribution-domain";
import { useState } from "react";
import type { PublicStudioOutput, PublicStudioPublication } from "../lib/studio-model";
import type { StudioDetail } from "../lib/studio-model";
import { STUDIO_PUBLICATION_LABELS, studioMessage } from "../lib/studio-model";

export function StudioPostingCheck({
  packageId,
  revision,
  accountId,
  outputs,
  publications,
}: {
  packageId: string;
  revision: number;
  accountId: string;
  outputs: PublicStudioOutput[];
  publications: PublicStudioPublication[];
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    checks: Record<string, PostingCheck>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${packageId}:${revision}:${accountId}`;
  const checks = result?.key === key ? result.checks : {};
  async function check() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/distribution/api/studio/${packageId}/posting-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = await response.json();
      if (!response.ok || !body.checks) throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
      setResult({ key, checks: body.checks });
    } catch {
      setError("STUDIO_POSTING_CHECK_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Posting history" className="panel" style={{ marginBlock: 12 }}>
      <h4>Posted or not posted?</h4>
      <p>
        Studio checks its posting history and the selected channel before each new send. Older
        revisions and the same excerpt in another package are included.
      </p>
      <button type="button" className="button" onClick={check} disabled={busy}>
        {busy ? "Checking channel…" : "Check channel for existing posts"}
      </button>
      {error && <p role="alert">{studioMessage(error)}</p>}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            tableLayout: "fixed",
            textAlign: "left",
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr>
              <th style={{ width: "40%", padding: "12px 8px" }}>File</th>
              <th style={{ padding: "12px 8px" }}>Posting status</th>
              <th style={{ padding: "12px 8px" }}>Existing post / last check</th>
            </tr>
          </thead>
          <tbody>
            {outputs.map((output) => {
              const receipts = publications.filter(
                (p) => p.outputId === output.id && p.selectedAccountId === accountId,
              );
              const receipt = receipts.find((p) => p.status === "PUBLISHED") ?? receipts.at(-1);
              const check = checks[output.id] ?? receipt?.duplicateCheck;
              const match = check?.matches[0];
              const status =
                receipt?.status === "PUBLISHED"
                  ? "Posted through Studio"
                  : match?.state === "POSTED"
                    ? "Already posted — will skip"
                    : match?.state === "IN_PROGRESS"
                      ? "Already queued — will skip"
                      : match
                        ? "Possible duplicate — review required"
                        : check?.error
                          ? "Check failed — posting blocked"
                          : receipt
                            ? STUDIO_PUBLICATION_LABELS[receipt.status]
                            : check
                              ? "No match found in checked history"
                              : "Not posted through Studio · channel not checked";
              return (
                <tr key={output.id}>
                  <td
                    style={{
                      verticalAlign: "top",
                      padding: "12px 8px",
                      overflowWrap: "anywhere",
                      borderTop: "1px solid #ddd",
                    }}
                  >
                    <strong>{output.title}</strong>
                    <details>
                      <summary>Filename</summary>
                      <small>{output.asset?.filename ?? output.title}</small>
                    </details>
                  </td>
                  <td>
                    {status}
                    {check?.error && <p>{studioMessage(check.error)}</p>}
                  </td>
                  <td>
                    {(check?.matches ?? [])
                      .filter((m) => m.url)
                      .map((m, i) => (
                        <p key={`${m.url}-${i}`}>
                          <a href={m.url ?? ""} target="_blank" rel="noreferrer">
                            Compare existing video
                          </a>
                          {m.postedAt ? ` · ${new Date(m.postedAt).toLocaleString()}` : ""}
                        </p>
                      ))}
                    {receipt?.remoteUrl && (
                      <a href={receipt.remoteUrl} target="_blank" rel="noreferrer">
                        Open published content
                      </a>
                    )}
                    {check && (
                      <p>
                        Checked {new Date(check.checkedAt).toLocaleString()} · {check.scanned}{" "}
                        channel posts
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        Channel checks include uploads made outside Studio that Buffer has synced. Very recent,
        private or older uploads may be missing. Renamed or re-edited videos may not match; compare
        suspected duplicates before posting. A failed or incomplete check blocks sending.
      </p>
    </section>
  );
}

export function StudioDraftPostingHistory({ detail }: { detail: StudioDetail }) {
  const [selected, setSelected] = useState("");
  const accounts =
    detail.readiness.channels
      .find((c) => c.channel === "youtube")
      ?.accounts?.filter((a) => !a.connectionPending) ?? [];
  const account =
    accounts.find((a) => a.id === selected) ?? accounts.find((a) => a.isDefault) ?? accounts[0];
  const outputs = detail.package.outputs.filter((o) => o.channel === "youtube" && o.included);
  if (!account || !outputs.length) return null;
  return (
    <details className="panel" style={{ marginBlock: 16 }}>
      <summary>Posting history · check for duplicates</summary>
      <label>
        YouTube account to check
        <select value={account.id} onChange={(event) => setSelected(event.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.isDefault ? " · Default" : ""}
            </option>
          ))}
        </select>
      </label>
      {account.channelUrl && (
        <p>
          Destination:{" "}
          <a href={account.channelUrl} target="_blank" rel="noreferrer">
            {account.channelUrl}
          </a>
        </p>
      )}
      <StudioPostingCheck
        key={`${detail.package.id}:${account.id}`}
        packageId={detail.package.id}
        revision={detail.package.revision}
        accountId={account.id}
        outputs={outputs}
        publications={detail.publications}
      />
    </details>
  );
}
