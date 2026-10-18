import type { StudioOutput } from "./intelligent-content";
import { parseStudioAssetKey } from "./studio-assets";
import type { StudioSourceScreen } from "./studio-presentation";
export const STUDIO_POST_ART_POLICY = "illustrated-teaching-post-v2" as const;
export type StudioPostArt = {
  policy: typeof STUDIO_POST_ART_POLICY | "illustrated-teaching-post-v1";
  excerpt: string;
  prompt: string;
  sourceSha256: string;
  renderedSha256: string;
  fileVersion: number;
  model: string;
  reviewedAt: string;
  image: NonNullable<NonNullable<StudioSourceScreen["illustrations"]>[number]["generated"]>;
  checks: {
    contextFaithful: boolean;
    textAccurate: boolean;
    textReadable: boolean;
    brandingVisible: boolean;
    noClipping: boolean;
    /** Legacy v1 evidence remains readable; new renders require cleanPresentation. */
    disclosureVisible?: boolean;
    cleanPresentation?: boolean;
    reason: string;
  };
};
/** Give the designer exact eligible passages instead of asking it to recopy approved prose. */
export function studioPostExcerptCandidates(body: string): string[] {
  const clean = body.replace(/\n\n(?:@sgsswamiji|SGS Datta Sannidhi)\s*$/u, "").trim();
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(clean)];
  const result: string[] = [];
  for (let start = 0; start < sentences.length; start++) {
    for (let end = start; end < sentences.length; end++) {
      const first = sentences[start];
      const last = sentences[end];
      if (!first || !last) continue;
      const excerpt = clean.slice(first.index, last.index + last.segment.length).trim();
      if ([...excerpt].length > 320) break;
      try {
        validateStudioPostExcerpt(excerpt, body);
        result.push(excerpt);
      } catch {
        // Incomplete sentences and branding are not eligible artwork excerpts.
      }
    }
  }
  return [...new Set(result)];
}
export function validateStudioPostExcerpt(excerpt: string, body: string): void {
  const clean = body.replace(/\n\n(?:@sgsswamiji|SGS Datta Sannidhi)\s*$/u, "").trim();
  const start = typeof excerpt === "string" ? clean.indexOf(excerpt) : -1;
  if (
    !excerpt?.trim() ||
    excerpt !== excerpt.trim() ||
    [...excerpt].length > 320 ||
    start < 0 ||
    (start > 0 && !/[.!?।॥]\s+$/u.test(clean.slice(0, start))) ||
    !/[.!?।॥]$/u.test(excerpt)
  )
    throw Error("STUDIO_POST_EXCERPT_INVALID");
}
export function validateStudioPostArt(
  output: StudioOutput,
  sourceSha256: string,
  identity: { masterId: string; versionId: string; packageId: string },
): void {
  const value = output.postArt;
  if (
    !value ||
    output.format !== "post" ||
    ![STUDIO_POST_ART_POLICY, "illustrated-teaching-post-v1"].includes(value.policy) ||
    !output.asset ||
    output.asset.mimeType !== "image/png" ||
    value.sourceSha256 !== sourceSha256 ||
    value.renderedSha256 !== output.asset.sha256 ||
    value.fileVersion !== (output.fileVersion ?? 1) ||
    !value.model ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    !value.prompt?.trim() ||
    value.prompt.length > 2000
  )
    throw Error("STUDIO_POST_ART_INVALID");
  validateStudioPostExcerpt(value.excerpt, output.body);
  const parsed = parseStudioAssetKey(value.image?.asset?.storageKey ?? "");
  if (
    !parsed ||
    parsed.extension !== "png" ||
    parsed.identity.masterId !== identity.masterId ||
    parsed.identity.sourceVersionId !== identity.versionId ||
    parsed.identity.packageId !== identity.packageId ||
    !/^[a-f0-9]{64}$/.test(value.image.asset.sha256) ||
    parsed.filename !== value.image.asset.filename ||
    value.image.asset.mimeType !== "image/png" ||
    !Number.isSafeInteger(value.image.asset.byteSize) ||
    value.image.asset.byteSize < 1 ||
    value.image.asset.byteSize > 16 * 1024 * 1024 ||
    value.image.provider !== "gemini" ||
    !value.image.model ||
    !value.image.reviewerModel ||
    !Number.isFinite(Date.parse(value.image.reviewedAt)) ||
    !Number.isFinite(Date.parse(value.image.generatedAt))
  )
    throw Error("STUDIO_POST_ART_INVALID");
  for (const checks of [value.checks, value.image.checks]) {
    if (
      !checks ||
      !checks.reason?.trim() ||
      checks.reason.length > 4000 ||
      Object.entries(checks).some(([k, v]) => k !== "reason" && v !== true)
    )
      throw Error("STUDIO_POST_ART_INVALID");
  }
  if (
    ![
      value.checks.contextFaithful,
      value.checks.textAccurate,
      value.checks.textReadable,
      value.checks.brandingVisible,
      value.checks.noClipping,
      value.policy === "illustrated-teaching-post-v1"
        ? value.checks.disclosureVisible
        : value.checks.cleanPresentation,
      value.policy === STUDIO_POST_ART_POLICY ? value.image.checks.photorealistic : true,
      value.image.checks.contextFaithful,
      value.image.checks.nonDeceptive,
      value.image.checks.noInventedText,
      value.image.checks.visualQuality,
      value.image.checks.safeComposition,
    ].every((v) => v === true)
  )
    throw Error("STUDIO_POST_ART_INVALID");
}
