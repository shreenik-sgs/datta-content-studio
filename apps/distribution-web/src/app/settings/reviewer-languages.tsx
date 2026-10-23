"use client";
import { REVIEWER_LANGUAGES } from "@satsang/distribution-domain";
import { useCallback, useEffect, useState } from "react";
import { studioMessage } from "../../lib/studio-model";

type Reviewer = { id: string; displayName: string; languages: string[] };
const API = "/distribution/api/settings/reviewers";
export function ReviewerLanguages() {
  const [reviewers, setReviewers] = useState<Reviewer[] | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(API, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      setReviewers(data.reviewers);
    } catch {
      setError("Reviewer languages could not load. Retry to see the current assignments.");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section id="reviewer-languages" className="card" aria-labelledby="reviewer-languages-heading">
      <h2 id="reviewer-languages-heading">Reviewer languages</h2>
      <p>
        Assign only languages each Content Approver can understand in the original recording.
        English subtitles do not replace source-language review.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {!reviewers && !error && <p>Loading reviewers…</p>}
      {error && (
        <button className="button" type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh reviewers
        </button>
      )}
      {reviewers?.length === 0 && <p>No active Content Approvers have been configured.</p>}
      {reviewers?.map((reviewer) => (
        <form
          key={`${reviewer.id}:${reviewer.languages.join(",")}`}
          aria-label={`${reviewer.displayName} languages`}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const data = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            setMessage("");
            try {
              const response = await fetch(API, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  operatorId: reviewer.id,
                  expectedLanguages: reviewer.languages,
                  languages: data.getAll("language"),
                  confirmProficiency: data.get("confirmed") === "on",
                }),
              });
              const body = await response.json();
              if (!response.ok) throw Error(body.error);
              setReviewers(body.reviewers);
              setMessage(
                `Languages saved for ${reviewer.displayName}. Existing content and approval decisions are unchanged.`,
              );
            } catch (e) {
              setError(studioMessage(e instanceof Error ? e.message : "unavailable"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy}>
            <legend>{reviewer.displayName}</legend>
            <div className="actions wrap">
              {Object.entries(REVIEWER_LANGUAGES).map(([code, label]) => (
                <label key={code} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    style={{ width: "auto" }}
                    type="checkbox"
                    name="language"
                    value={code}
                    defaultChecked={reviewer.languages.includes(code)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBlock: 16 }}>
              <input style={{ width: "auto" }} type="checkbox" name="confirmed" required />I confirm
              this reviewer can accurately review the selected spoken languages.
            </label>
            <p className="muted">
              Removing an assignment also blocks future posting of approvals that require that
              language until a qualified reviewer reviews them.
            </p>
            <button className="button primary" type="submit">
              {busy ? "Saving…" : "Save reviewer languages"}
            </button>
          </fieldset>
        </form>
      ))}
    </section>
  );
}
