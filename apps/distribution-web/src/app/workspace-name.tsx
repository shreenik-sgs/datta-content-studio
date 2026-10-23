"use client";
import { ONLINE_IMPORT_ERRORS } from "@satsang/distribution-domain";
import { type FormEvent, useState } from "react";

/** Renames an organizing label only; never edits approved content or queues work. */
export function WorkspaceName({
  kind,
  id,
  title,
  name,
  onSaved,
}: {
  kind: "master" | "import";
  id: string;
  title: string;
  name?: string | null | undefined;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!value) {
      setError("Enter a name for this source.");
      return;
    }
    setBusy(true);
    setError("");
    let saved = false;
    try {
      const response = await fetch(
        kind === "import"
          ? "/distribution/api/content/import"
          : `/distribution/api/content/${id}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(kind === "import" ? { action: "rename", id } : {}),
            name: value,
            expectedName: name ?? null,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setError(
          ONLINE_IMPORT_ERRORS[result.error] ??
            "The name could not be saved. Refresh and try again.",
        );
        return;
      }
      saved = true;
      await onSaved();
      setEditing(false);
    } catch {
      setError(
        saved
          ? "Name saved. Refresh to see it throughout the workspace."
          : "The save could not be confirmed. Refresh to check the name before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!editing)
    return (
      <button
        className="button workspace-rename"
        type="button"
        aria-label={`Rename ${title}`}
        onClick={() => {
          setError("");
          setEditing(true);
        }}
      >
        Rename
      </button>
    );
  return (
    <form className="workspace-name-editor" onSubmit={save} aria-label={`Rename ${title}`}>
      <label>
        Name
        <input name="name" required maxLength={200} defaultValue={title} disabled={busy} />
      </label>
      <p className="muted">
        Used to organize this workspace. Source links, files and approvals stay unchanged.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save name"}
        </button>
        <button className="button" type="button" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
