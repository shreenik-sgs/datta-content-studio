import type { PrivateAssetStore } from "@satsang/distribution-assets";
import { studioGenerationPreviews } from "@satsang/distribution-db";
import type { StudioOutput, StudioPackage } from "@satsang/distribution-domain";
import { replaceStudioYoutubeFooter } from "@satsang/distribution-domain";
import { studioFingerprint } from "./studio-checkpoints.js";
import { refreshStudioClosingOutputs } from "./studio-closing-refresh.js";

type Entry = { fingerprint: string; value: unknown };

/** Only checked, uncommitted previews are eligible. Already reviewed drafts are never touched. */
export function studioPreviewClosingCandidates(pkg: StudioPackage, entries: Record<string, Entry>) {
  if (!pkg.request.youtubeClosing) return [];
  const visible = new Set(
    studioGenerationPreviews(pkg, "1970-01-01T00:00:00Z", entries).map((output) => output.id),
  );
  return Object.entries(entries).flatMap(([key, entry]) => {
    const output = entry.value as StudioOutput;
    const before = output?.presentationReview?.closingCard;
    const target = pkg.request.youtubeClosing;
    if (
      !target ||
      !visible.has(output?.id) ||
      output.channel !== "youtube" ||
      !before?.youtubeClosing ||
      before.destination !== "youtube" ||
      before.sourceBranding !== pkg.request.sourceBranding ||
      (output.workflow && output.workflow.status !== "DRAFT") ||
      (before.youtubeClosing.url === target.url &&
        before.youtubeClosing.label === target.label &&
        before.youtubeClosing.fullVideosUrl === target.fullVideosUrl)
    )
      return [];
    return [
      {
        key,
        entry,
        output: {
          ...output,
          body: replaceStudioYoutubeFooter(output.body, before.youtubeClosing, target),
        },
      },
    ];
  });
}

/** Reuse the verified closing-only renderer before paid discovery resumes. No AI requests,
 * workflow promotion, approval, or generation restart. Persistence must fence concurrent work. */
export async function refreshStudioPreviewClosings(input: {
  pkg: StudioPackage;
  entries: Record<string, Entry>;
  store: PrivateAssetStore;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  persist: (key: string, before: Entry, after: Entry) => Promise<void>;
}) {
  let count = 0;
  for (const item of studioPreviewClosingCandidates(input.pkg, input.entries)) {
    const [rendered] = await refreshStudioClosingOutputs({
      pkg: { ...input.pkg, outputs: [item.output] },
      store: input.store,
      env: input.env,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!rendered) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
    // A repaired card does not turn an old editorial preview into a current-run result.
    const output = { ...rendered, generatedAt: item.output.generatedAt };
    await input.persist(item.key, item.entry, {
      fingerprint: studioFingerprint({
        policy: "preview-closing-v1",
        previous: item.entry.fingerprint,
        output,
      }),
      value: output,
    });
    count++;
  }
  return count;
}
