import type { OnlineImport } from "./online-video";

/** Only unambiguous source IDs or exact titles are matched. Never guess by file order. */
export function matchOriginalRecordings(names: readonly string[], items: readonly OnlineImport[]) {
  const pending = items.filter((item) => item.source.kind === "video" && !item.masterId);
  const normalized = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const matches = names.map((name) => {
    const stem = name.replace(/\.[^.]+$/, "");
    const byId = pending.filter(
      (item) =>
        stem === `${item.source.provider}-${item.source.id}-master` ||
        stem.split(/[^A-Za-z0-9_-]+/).includes(item.source.id) ||
        stem.endsWith(`[${item.source.id}]`),
    );
    const candidates = byId.length
      ? byId
      : pending.filter((item) => item.title && normalized(stem) === normalized(item.title));
    return candidates.length === 1 ? (candidates[0]?.id ?? "") : "";
  });
  return matches.map((id) =>
    id && matches.filter((other) => other === id).length === 1 ? id : "",
  );
}

export const IMPORT_RECOVERY_ERRORS: Record<string, string> = {
  ORIGINAL_ALREADY_ATTACHED:
    "This recording already has a master. Its content and approvals have been preserved.",
  ORIGINAL_NOT_IN_PLAYLIST: "Choose an unfinished recording in this playlist for each file.",
  VERIFICATION_UNAVAILABLE:
    "The verification browser is unavailable. You can upload the original recordings into this playlist below.",
  VERIFICATION_NOT_CONFIGURED:
    "YouTube verification is not configured for this workspace. Ask your Studio administrator to enable the verification service. Your playlist is saved.",
  VERIFICATION_CONNECTION_FAILED:
    "Studio could not reach its YouTube verification service. Try again; if this continues, ask your Studio administrator to check the service. Your playlist is saved.",
  VERIFICATION_BROWSER_START_FAILED:
    "The verification service is running, but its browser could not start. Your Studio administrator needs to check the browser installation and sandbox. Your playlist is saved; uploading originals remains available.",
  VERIFICATION_EXPIRED:
    "This verification session has ended. Open Verify YouTube access again; your playlist is saved.",
  VERIFICATION_BUSY:
    "Another verification is already checking this playlist. Please wait for its result.",
  VERIFICATION_NOT_NEEDED:
    "All recordings in this source already have masters. Continue to curation.",
  VERIFICATION_FAILED:
    "YouTube still refused the download. You can return to verification or upload the original recordings below.",
};

/** Browser MIME labels vary; bytes are independently signature-checked by private storage. */
export function originalRecordingMimeType(name: string, mime: string) {
  if (["video/mp4", "audio/mpeg", "audio/mp4", "audio/wav"].includes(mime)) return mime;
  const extension = name.toLowerCase().split(".").pop();
  return (
    (
      { mp4: "video/mp4", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav" } as Record<
        string,
        string
      >
    )[extension ?? ""] ?? ""
  );
}
