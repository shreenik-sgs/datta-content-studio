import {
  type DistributionContext,
  createNativeIntelligenceRepository,
} from "@satsang/distribution-db";
import { nativeFeature, nativePolicy } from "./native-policy";
import { distributionPool } from "./runtime";
/** History remains readable when OFF. New native renders, approval and export
 * require a fresh policy decision before using already-recorded native evidence. */
export async function requireNativeRenderPolicy(
  request: Request,
  ctx: DistributionContext,
  reference: { masterId: string } | { artifactId: string },
) {
  if (!(await createNativeIntelligenceRepository(distributionPool()).governed(ctx, reference)))
    return;
  const flags = await nativePolicy(request);
  if (
    !nativeFeature(flags, "teaching_integrity_engine") ||
    !nativeFeature(flags, "native_language_review") ||
    !nativeFeature(flags, "native_clip_candidates")
  )
    throw new Error("FEATURE_UNAVAILABLE");
}
