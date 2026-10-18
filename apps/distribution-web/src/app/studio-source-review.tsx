"use client";
import { contentMasterSchema } from "@satsang/distribution-contracts";
import type { ContentMaster } from "@satsang/distribution-domain";
import { useEffect, useState } from "react";
import { studioMessage } from "../lib/studio-model";

/** Review the source in step 4 without leaving the selected package. */
export function StudioSourceReview({
  masterId,
  onApproved,
}: {
  masterId: string;
  onApproved: () => Promise<void>;
}) {
  const [source, setSource] = useState<ContentMaster | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/distribution/api/content/${masterId}/detail`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (active) setSource(contentMasterSchema.parse(data.content));
      })
      .catch(() => {
        if (active)
          setError("Could not load the master permissions. Reopen this package to retry.");
      });
    return () => {
      active = false;
    };
  }, [masterId]);
  if (source?.state === "APPROVED")
    return (
      <p>
        Master permissions approved. Next, confirm your review of the generated files and select{" "}
        <strong>Approve package</strong> below to continue to publishing.
      </p>
    );
  return (
    <section aria-label="Review master permissions" className="panel">
      <h3>Review master permissions</h3>
      {error && <p role="alert">{error}</p>}
      {!source ? (
        <p>Loading master permissions…</p>
      ) : (
        <>
          <p>{source.title}</p>
          <a href={`/distribution/api/content/${masterId}/media`} target="_blank" rel="noreferrer">
            View master recording
          </a>
          <dl>
            <dt>Rights holder</dt>
            <dd>{source.rights?.owner ?? "Not recorded"}</dd>
            <dt>Authorization</dt>
            <dd>{source.rights?.authorizationBasis ?? "Not recorded"}</dd>
            <dt>Allowed channels</dt>
            <dd>{source.rights?.channels.join(", ") ?? "None"}</dd>
            <dt>Territories</dt>
            <dd>{source.rights?.territories.join(", ") ?? "None"}</dd>
            <dt>Visibility</dt>
            <dd>{source.rights?.privacyClass ?? "Not recorded"}</dd>
            <dt>Release / expiry (UTC)</dt>
            <dd>
              {source.rights?.releaseAt ?? "Immediate"} / {source.rights?.expiresAt ?? "No expiry"}
            </dd>
          </dl>
          <button
            type="button"
            className="button primary"
            disabled={busy || source.state !== "RIGHTS_CLEARED"}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const response = await fetch(`/distribution/api/content/${masterId}/approve`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ expectedRevision: source.revision }),
                });
                const data = await response.json();
                if (!response.ok) throw Error(data.error);
                setSource(contentMasterSchema.parse(data.content));
                await onApproved();
              } catch (problem) {
                setError(studioMessage(problem instanceof Error ? problem.message : "unavailable"));
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve master permissions
          </button>
        </>
      )}
    </section>
  );
}
