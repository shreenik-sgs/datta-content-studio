"use client";
import {
  IMPORT_RECOVERY_ERRORS,
  MAX_ONLINE_MASTER_BYTES,
  ONLINE_IMPORT_ERRORS,
  type OnlineImport,
  matchOriginalRecordings,
  originalRecordingMimeType,
} from "@satsang/distribution-domain";
import { useState } from "react";

type Selection = {
  file: File;
  id: string;
  state: "waiting" | "uploading" | "saved" | "failed";
  message?: string;
};
export function PlaylistOriginals({
  item,
  items,
  onSaved,
}: { item: OnlineImport; items: OnlineImport[]; onSaved: () => Promise<void> }) {
  const [selected, setSelected] = useState<Selection[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const members =
    item.source.kind !== "video"
      ? (item.childIds ?? []).flatMap((id) => items.find((member) => member.id === id) ?? [])
      : [item];
  const pending = members.filter((member) => !member.masterId);
  if (!pending.length && !selected.length) return null;
  const valid =
    selected.length > 0 &&
    selected.every(
      (entry) =>
        entry.state === "saved" ||
        (entry.id &&
          entry.file.size > 0 &&
          entry.file.size <= MAX_ONLINE_MASTER_BYTES &&
          Boolean(originalRecordingMimeType(entry.file.name, entry.file.type)) &&
          selected.filter((other) => other.id === entry.id).length === 1),
    );
  async function upload() {
    if (!valid || busy) return;
    setBusy(true);
    setNotice("");
    let failed = 0;
    for (let index = 0; index < selected.length; index++) {
      const entry = selected[index];
      if (!entry || entry.state === "saved") continue;
      const update = (patch: Partial<Selection>) =>
        setSelected((current) =>
          current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
        );
      update({ state: "uploading", message: "Uploading…" });
      try {
        const response = await fetch(
          `/distribution/api/content/import/${entry.id}/original?bundle=${item.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": originalRecordingMimeType(entry.file.name, entry.file.type),
              "X-Original-Filename": encodeURIComponent(entry.file.name),
            },
            body: entry.file,
          },
        );
        const body = await response.json();
        if (!response.ok)
          throw Error(
            IMPORT_RECOVERY_ERRORS[body.error] ??
              ONLINE_IMPORT_ERRORS[body.error] ??
              (body.error === "INVALID_MEDIA"
                ? "Choose a valid MP4, MP3, M4A or WAV recording. The file’s contents must match its format."
                : undefined) ??
              (response.status === 413
                ? "This file exceeds 20 GB."
                : response.status === 429
                  ? "Another upload is in progress. Retry this file when it finishes."
                  : "Upload failed. Your other recordings are retained; retry this file."),
          );
        update({ state: "saved", message: "Master saved" });
      } catch (error) {
        failed++;
        update({
          state: "failed",
          message: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    }
    await onSaved().catch(() => undefined);
    setNotice(
      failed
        ? `${failed} recording(s) need another attempt. Successfully saved recordings will not be uploaded again.`
        : item.curation
          ? "Originals saved. Curation will continue using this playlist’s shared settings."
          : "Originals saved. Set this playlist’s permissions and outputs once to start curation.",
    );
    setBusy(false);
  }
  return (
    <details
      className="panel import-recovery"
      onToggle={(event) => {
        if (!event.currentTarget.open && busy) event.currentTarget.open = true;
      }}
    >
      <summary>Upload original recordings</summary>
      <p>
        Select the authorized originals together. They stay in this playlist, with its permissions
        and output settings. Completed content is preserved.
      </p>
      <fieldset disabled={busy}>
        <label>
          Select recordings (MP4, MP3, M4A or WAV; up to 20 GB each)
          <input
            type="file"
            multiple
            accept=".mp4,.mp3,.m4a,.wav,video/mp4,audio/mpeg,audio/wav,audio/mp4"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []).slice(0, 100);
              const ids = matchOriginalRecordings(
                files.map((file) => file.name),
                pending,
              );
              setSelected(
                files.map((file, index) => ({
                  file,
                  id:
                    pending.length === 1 && files.length === 1
                      ? (pending[0]?.id ?? "")
                      : (ids[index] ?? ""),
                  state: "waiting",
                })),
              );
              setNotice("");
            }}
          />
        </label>
        {selected.length > 0 && (
          <>
            <p>
              Check which playlist recording each file belongs to. A source video ID in the filename
              is matched automatically; uncertain matches need your selection.
            </p>
            <ul>
              {selected.map((entry, index) => (
                <li key={`${index}-${entry.file.name}`}>
                  <strong>{entry.file.name}</strong>
                  <label>
                    Playlist recording for {entry.file.name}
                    <select
                      value={entry.id}
                      disabled={entry.state === "saved"}
                      onChange={(event) =>
                        setSelected((current) =>
                          current.map((row, position) =>
                            position === index ? { ...row, id: event.target.value } : row,
                          ),
                        )
                      }
                    >
                      <option value="">Choose the matching recording</option>
                      {members
                        .filter((member) => !member.masterId || member.id === entry.id)
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {members.indexOf(member) + 1}. {member.title ?? member.source.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  {(!entry.file.size ||
                    !originalRecordingMimeType(entry.file.name, entry.file.type)) && (
                    <p role="alert">Choose a nonempty MP4, MP3, M4A or WAV recording.</p>
                  )}
                  {entry.file.size > MAX_ONLINE_MASTER_BYTES && (
                    <p role="alert">This file exceeds 20 GB.</p>
                  )}
                  {entry.id && selected.filter((other) => other.id === entry.id).length > 1 && (
                    <p role="alert">
                      Select a different recording; two files are assigned to this one.
                    </p>
                  )}
                  {entry.message && (
                    <p role={entry.state === "failed" ? "alert" : "status"}>{entry.message}</p>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="button primary"
              disabled={!valid || selected.every((entry) => entry.state === "saved")}
              onClick={() => void upload()}
            >
              {busy ? "Uploading recordings…" : "Upload originals and continue"}
            </button>
          </>
        )}
      </fieldset>
      {notice && <output>{notice}</output>}
    </details>
  );
}
