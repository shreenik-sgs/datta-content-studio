import type { StudioOutput, StudioPackage, StudioPublication } from "./intelligent-content";

export type PostingMatch = {
  state: "POSTED" | "IN_PROGRESS" | "NEEDS_REVIEW";
  reason: "SAME_FILE" | "SAME_EXCERPT" | "SAME_OUTPUT" | "SIMILAR_METADATA";
  origin: "studio" | "channel";
  url: string | null;
  postedAt: string | null;
};
export type PostingCheck = {
  checkedAt: string;
  destination: string;
  scanned: number;
  error: string | null;
  matches: PostingMatch[];
};
export type ChannelPost = {
  id: string;
  title: string;
  text: string;
  status: string;
  url: string | null;
  sentAt: string | null;
  assetSha256: string | null;
};
export type PostingOutput = Pick<
  StudioOutput,
  | "id"
  | "language"
  | "format"
  | "title"
  | "body"
  | "startMs"
  | "endMs"
  | "sourceTrim"
  | "sourceSegmentIds"
> & { asset: { sha256: string } | null };

/** Intentionally excludes the render/card checksum and package revision. */
export function studioExcerptIdentity(sourceSha: string, output: PostingOutput): string {
  const range = output.sourceTrim ?? { startMs: output.startMs, endMs: output.endMs };
  return JSON.stringify([
    sourceSha,
    output.language,
    output.format,
    range.startMs,
    range.endMs,
    range.startMs === null ? [...output.sourceSegmentIds].sort() : null,
  ]);
}
export function studioKnownPostingMatch(
  sourceSha: string,
  output: PostingOutput,
  previous: { publication: StudioPublication; package: StudioPackage },
): PostingMatch | null {
  const p = previous.publication;
  if (!["RUNNING", "PROCESSING", "PUBLISHED", "UNCERTAIN", "FAILED"].includes(p.status))
    return null;
  const old = previous.package.outputs.find((o) => o.id === p.outputId);
  if (!old) return null;
  const reason =
    output.asset && old.asset?.sha256 === output.asset.sha256
      ? "SAME_FILE"
      : old.id === output.id
        ? "SAME_OUTPUT"
        : studioExcerptIdentity(sourceSha, output) ===
            studioExcerptIdentity(previous.package.source.sha256, old)
          ? "SAME_EXCERPT"
          : null;
  return reason
    ? {
        state:
          p.status === "PUBLISHED"
            ? "POSTED"
            : ["RUNNING", "PROCESSING"].includes(p.status)
              ? "IN_PROGRESS"
              : "NEEDS_REVIEW",
        reason,
        origin: "studio",
        url: p.remoteUrl,
        postedAt: p.status === "PUBLISHED" ? p.updatedAt : null,
      }
    : null;
}
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
function similar(first: string, second: string, min: number): boolean {
  const a = normalize(first);
  const b = normalize(second);
  if (a.length < min || b.length < min) return false;
  if (a === b) return true;
  const x = new Set(a.split(" "));
  const y = new Set(b.split(" "));
  return (
    Math.min(x.size, y.size) >= 6 &&
    [...x].filter((w) => y.has(w)).length / new Set([...x, ...y]).size >= 0.85
  );
}
/** Metadata is a suspicion, never proof of identical video or permission to mark it published. */
export function studioChannelPostingMatches(
  output: PostingOutput,
  posts: ChannelPost[],
): PostingMatch[] {
  return posts.flatMap((p) => {
    if (!["sent", "scheduled", "sending", "pending"].includes(p.status)) return [];
    const exact = Boolean(output.asset && p.assetSha256 === output.asset.sha256);
    if (!exact && !similar(output.title, p.title, 12) && !similar(output.body, p.text, 80))
      return [];
    return [
      {
        state: exact ? (p.status === "sent" ? "POSTED" : "IN_PROGRESS") : "NEEDS_REVIEW",
        reason: exact ? "SAME_FILE" : "SIMILAR_METADATA",
        origin: "channel",
        url: p.url,
        postedAt: p.sentAt,
      } as PostingMatch,
    ];
  });
}
export function postingCheckBlock(check: PostingCheck): string | null {
  if (check.error) return check.error;
  if (check.matches.some((m) => m.state === "POSTED")) return "STUDIO_ALREADY_POSTED";
  if (check.matches.some((m) => m.state === "IN_PROGRESS")) return "STUDIO_ALREADY_QUEUED";
  return check.matches.length ? "STUDIO_POSSIBLE_DUPLICATE" : null;
}
