/** Local review artifacts only. This is deliberately not a publication or approval contract. */
export const PREVIEW_REVIEW_NOTICE = "TEST PREVIEW — native-language review required" as const;
export const PREVIEW_SUMMARY_LABEL =
  "Draft summary — not a source quote or approved translation" as const;
export const PREVIEW_DESTINATIONS = ["youtube", "facebook", "instagram", "x", "reddit"] as const;
export type PreviewDestination = (typeof PREVIEW_DESTINATIONS)[number];
export type PreviewArtifactKind = "short" | "reel" | "post" | "blog" | "copy" | "poster";
export type PreviewArtifactAspect = "9:16" | "4:5" | "1:1" | "16:9" | "prose";

/** Readable portable filenames; full master and artifact identities remain in the manifest. */
export function previewArtifactFilename(input: {
  sourceId: string;
  sourceSha256: string;
  channel: PreviewDestination;
  kind: PreviewArtifactKind;
  language: string;
  aspect: PreviewArtifactAspect;
  artifactId: string;
  extension: "mp4" | "png" | "html" | "md" | "txt";
}): string {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
  const endings: Record<PreviewArtifactKind, readonly string[]> = {
    short: ["mp4"],
    reel: ["mp4"],
    post: ["png"],
    blog: ["html", "md"],
    copy: ["txt"],
    poster: ["png"],
  };
  if (
    !id.test(input.sourceId) ||
    input.sourceId.trim() !== input.sourceId ||
    !id.test(input.artifactId) ||
    input.artifactId.trim() !== input.artifactId ||
    input.sourceSha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    !PREVIEW_DESTINATIONS.includes(input.channel) ||
    !Object.hasOwn(endings, input.kind) ||
    !endings[input.kind].includes(input.extension) ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language) ||
    input.language.trim() !== input.language ||
    input.language.length > 12 ||
    !["9:16", "4:5", "1:1", "16:9", "prose"].includes(input.aspect)
  )
    throw new Error("INVALID_PREVIEW_ARTIFACT_NAME");
  // Stable FNV-1a identity suffix distinguishes truncated IDs and case-insensitive filesystems.
  // It is a filename discriminator only; the manifest carries cryptographic source/file hashes.
  let identity = 0xcbf29ce484222325n;
  for (const character of input.artifactId)
    identity = BigInt.asUintN(64, (identity ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n);
  const filename = `sgs-${input.sourceId.slice(0, 12)}-${input.sourceSha256.slice(0, 12)}-${input.channel}-${input.kind}-${input.language}-${input.aspect.replace(":", "x")}-${input.artifactId.slice(0, 12)}-${identity.toString(16).padStart(16, "0")}.${input.extension}`;
  if (filename.length > 100) throw new Error("INVALID_PREVIEW_ARTIFACT_NAME");
  return filename;
}
export type PreviewAttribution = {
  narrator: string;
  subject: string;
  kind: "discourse_summary" | "story_character" | "scripture";
  quotedSpeaker: string | null;
};
export type PreviewBrandProfile = {
  id: string;
  revision: number;
  name: string;
  speaker: string;
  logoSha256: string;
  profileSha256: string;
};
export type PreviewTranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  language: string;
  provenance: "machine_transcript" | "human_transcript";
};
export type ContentPreviewPack = {
  schemaVersion: 1;
  world: "TEST";
  status: "DRAFT_REVIEW_REQUIRED";
  publishAllowed: false;
  source: {
    id: string;
    url: string;
    title: string;
    displayTitle: string;
    sha256: string;
    durationMs: number;
    language: string;
    descriptionSha256: string;
    transcriptSha256: string;
  };
  brand: PreviewBrandProfile;
  segments: PreviewTranscriptSegment[];
  /** Titles and summaries are draft editorial prose, never verbatim source or approved translation. */
  clips: {
    id: string;
    title: string;
    summary: string;
    attribution: PreviewAttribution;
    startMs: number;
    endMs: number;
    segmentIds: string[];
    formats: ("short" | "reel")[];
  }[];
  posts: {
    id: string;
    title: string;
    summary: string;
    attribution: PreviewAttribution;
    sourceClipId: string;
    format: "post";
  }[];
  blogs: {
    id: string;
    title: string;
    dek: string;
    paragraphs: string[];
    attribution: PreviewAttribution;
    sourceClipIds: string[];
    format: "blog";
  }[];
  /** Destination recommendations are manual draft copy, not verified provider adoption. */
  platforms: {
    channel: PreviewDestination;
    title: string;
    body: string;
    assetIds: string[];
    recommendation: string;
  }[];
  /** Optional native excerpts stay visibly unreviewed; semantic shadows cannot become quotes. */
  quotes?:
    | {
        id: string;
        kind: "unreviewed_native_quote";
        text: string;
        language: string;
        sourceClipId: string;
        segmentIds: string[];
        attribution: PreviewAttribution;
      }[]
    | undefined;
};

const checksum = /^[a-f0-9]{64}$/;
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
function requireValue(value: boolean, reason: string): asserts value {
  if (!value) throw new Error(`INVALID_PREVIEW_PACK:${reason}`);
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function validText(value: string, max = 20000): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    })
  );
}
function validRange(startMs: number, endMs: number, durationMs: number): boolean {
  return (
    Number.isSafeInteger(startMs) &&
    Number.isSafeInteger(endMs) &&
    startMs >= 0 &&
    endMs > startMs &&
    endMs <= durationMs
  );
}
function validLanguage(value: string): boolean {
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
}
function attribution(value: PreviewAttribution, speaker: string): void {
  requireValue(value.narrator === speaker && validText(value.subject, 1000), "ATTRIBUTION");
  requireValue(
    ["discourse_summary", "story_character", "scripture"].includes(value.kind),
    "ATTRIBUTION",
  );
  requireValue(
    value.kind === "discourse_summary"
      ? value.quotedSpeaker === null
      : value.quotedSpeaker !== null && validText(value.quotedSpeaker, 300),
    "QUOTED_SPEAKER",
  );
}

/** Hash this exact UTF-8 string with SHA-256; never hash an unverified URL in place of logo bytes. */
export function canonicalPreviewBrandProfile(
  value: Omit<PreviewBrandProfile, "profileSha256">,
): string {
  return JSON.stringify({
    id: value.id,
    revision: value.revision,
    name: value.name,
    speaker: value.speaker,
    logoSha256: value.logoSha256,
  });
}

/**
 * Validate semantics after parsing the strict JSON contract. This checks hash syntax only;
 * the I/O boundary must compare all hashes with actual source/transcript/brand file bytes.
 * Successful validation does not authorize a render job, human approval, export or send.
 */
export function validateContentPreviewPack(pack: ContentPreviewPack): void {
  requireValue(
    pack.schemaVersion === 1 &&
      pack.world === "TEST" &&
      pack.status === "DRAFT_REVIEW_REQUIRED" &&
      pack.publishAllowed === false,
    "PREVIEW_ONLY",
  );
  const { source, brand } = pack;
  requireValue(
    safeId.test(source.id) &&
      validText(source.title, 1000) &&
      validText(source.displayTitle, 68) &&
      Number.isSafeInteger(source.durationMs) &&
      source.durationMs > 0 &&
      source.durationMs <= 86400000 &&
      validLanguage(source.language),
    "SOURCE",
  );
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source.url);
  } catch {
    throw new Error("INVALID_PREVIEW_PACK:SOURCE_URL");
  }
  requireValue(
    sourceUrl.protocol === "https:" && !sourceUrl.username && !sourceUrl.password,
    "SOURCE_URL",
  );
  requireValue(
    [
      source.sha256,
      source.descriptionSha256,
      source.transcriptSha256,
      brand.logoSha256,
      brand.profileSha256,
    ].every((value) => checksum.test(value)),
    "CHECKSUM",
  );
  requireValue(
    safeId.test(brand.id) &&
      Number.isSafeInteger(brand.revision) &&
      brand.revision > 0 &&
      validText(brand.name, 300) &&
      validText(brand.speaker, 300),
    "BRAND",
  );
  requireValue(
    pack.segments.length > 0 &&
      pack.segments.length <= 20000 &&
      unique(pack.segments.map((segment) => segment.id)),
    "SEGMENTS",
  );
  let previousStart = -1;
  for (const segment of pack.segments) {
    requireValue(
      safeId.test(segment.id) &&
        validRange(segment.startMs, segment.endMs, source.durationMs) &&
        segment.startMs >= previousStart &&
        validText(segment.text) &&
        validLanguage(segment.language) &&
        ["machine_transcript", "human_transcript"].includes(segment.provenance),
      "SEGMENT",
    );
    previousStart = segment.startMs;
  }
  const segments = new Map(pack.segments.map((segment) => [segment.id, segment]));
  const segmentIndices = new Map(pack.segments.map((segment, index) => [segment.id, index]));
  requireValue(
    pack.clips.length > 0 &&
      pack.clips.length <= 100 &&
      pack.posts.length > 0 &&
      pack.posts.length <= 100 &&
      pack.blogs.length > 0 &&
      pack.blogs.length <= 100,
    "FORMAT_COVERAGE",
  );
  const allAssets = [...pack.clips, ...pack.posts, ...pack.blogs];
  requireValue(
    allAssets.every((asset) => safeId.test(asset.id)) && unique(allAssets.map((asset) => asset.id)),
    "ASSET_ID",
  );
  const clipIds = new Set(pack.clips.map((clip) => clip.id));
  const formats = new Set<string>();
  for (const clip of pack.clips) {
    requireValue(validText(clip.title, 1000) && validText(clip.summary), "CLIP_COPY");
    attribution(clip.attribution, brand.speaker);
    requireValue(validRange(clip.startMs, clip.endMs, source.durationMs), "CLIP_RANGE");
    requireValue(
      clip.formats.length > 0 &&
        unique(clip.formats) &&
        clip.formats.every((format) => format === "short" || format === "reel"),
      "CLIP_FORMAT",
    );
    for (const format of clip.formats) formats.add(format);
    requireValue(clip.segmentIds.length > 0 && unique(clip.segmentIds), "CLIP_SEGMENTS");
    let previousIndex = -1;
    for (const id of clip.segmentIds) {
      const segment = segments.get(id);
      const index = segmentIndices.get(id) ?? -1;
      requireValue(
        segment !== undefined &&
          index > previousIndex &&
          segment.startMs >= clip.startMs &&
          segment.endMs <= clip.endMs,
        "CLIP_SEGMENT_RANGE",
      );
      previousIndex = index;
    }
    // Omitted words inside a time range cannot silently disappear from its evidence record.
    requireValue(
      pack.segments
        .filter((segment) => segment.endMs > clip.startMs && segment.startMs < clip.endMs)
        .every((segment) => clip.segmentIds.includes(segment.id)),
      "CLIP_EVIDENCE_INCOMPLETE",
    );
  }
  requireValue(formats.has("short") && formats.has("reel"), "FORMAT_COVERAGE");
  for (const post of pack.posts) {
    requireValue(
      post.format === "post" &&
        validText(post.title, 1000) &&
        validText(post.summary) &&
        clipIds.has(post.sourceClipId),
      "POST",
    );
    attribution(post.attribution, brand.speaker);
  }
  for (const blog of pack.blogs) {
    requireValue(
      blog.format === "blog" &&
        validText(blog.title, 1000) &&
        validText(blog.dek) &&
        blog.paragraphs.length > 0 &&
        blog.paragraphs.length <= 100 &&
        blog.paragraphs.every((paragraph) => validText(paragraph)) &&
        blog.sourceClipIds.length > 0 &&
        unique(blog.sourceClipIds) &&
        blog.sourceClipIds.every((id) => clipIds.has(id)),
      "BLOG",
    );
    attribution(blog.attribution, brand.speaker);
  }
  requireValue(
    pack.platforms.length === PREVIEW_DESTINATIONS.length &&
      unique(pack.platforms.map((platform) => platform.channel)) &&
      pack.platforms.every((platform) => PREVIEW_DESTINATIONS.includes(platform.channel)),
    "DESTINATION_COVERAGE",
  );
  const assetIds = new Set(allAssets.map((asset) => asset.id));
  for (const platform of pack.platforms) {
    requireValue(
      validText(platform.title, 1000) &&
        validText(platform.body) &&
        validText(platform.recommendation) &&
        platform.assetIds.length > 0 &&
        unique(platform.assetIds) &&
        platform.assetIds.every((id) => assetIds.has(id)),
      "DESTINATION_COPY",
    );
  }
  const quotes = pack.quotes ?? [];
  requireValue(quotes.length <= 100 && unique(quotes.map((quote) => quote.id)), "QUOTES");
  for (const quote of quotes) {
    const clip = pack.clips.find((item) => item.id === quote.sourceClipId);
    requireValue(
      safeId.test(quote.id) &&
        quote.kind === "unreviewed_native_quote" &&
        clip !== undefined &&
        quote.segmentIds.length > 0 &&
        unique(quote.segmentIds),
      "QUOTE",
    );
    requireValue(
      quote.segmentIds.every((id) => clip.segmentIds.includes(id)),
      "QUOTE_SOURCE",
    );
    const sourceSegments = quote.segmentIds.map((id) => segments.get(id));
    requireValue(
      sourceSegments.every(
        (segment) => segment !== undefined && segment.language === quote.language,
      ) && quote.text === sourceSegments.map((segment) => segment?.text).join("\n"),
      "QUOTE_FIDELITY",
    );
    const indices = quote.segmentIds.map((id) => clip.segmentIds.indexOf(id));
    requireValue(
      indices.every(
        (index, position) => position === 0 || index === (indices[position - 1] ?? -2) + 1,
      ),
      "QUOTE_CONTIGUITY",
    );
    attribution(quote.attribution, brand.speaker);
  }
}
