import {
  nativeProposalCommandSchema,
  nativeReviewCommandSchema,
} from "@satsang/distribution-contracts";
import { createNativeIntelligenceRepository } from "@satsang/distribution-db";
import { z } from "zod";
import { json, readBoundedBody, safeProblem } from "../../../../lib/http";
import { nativeFeature, nativePolicy } from "../../../../lib/native-policy";
import { access, distributionPool } from "../../../../lib/runtime";
export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  const flags = await nativePolicy(request);
  if (!nativeFeature(flags, "teaching_integrity_engine"))
    return json({ error: "feature_unavailable" }, 404);
  try {
    const { id } = await params;
    z.string().uuid().parse(id);
    await auth.repo.get(auth.context, id);
    return json({
      ...(await createNativeIntelligenceRepository(distributionPool()).list(auth.context, id)),
      flags,
    });
  } catch (e) {
    return safeProblem(e);
  }
}
export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  const flags = await nativePolicy(request);
  if (!nativeFeature(flags, "teaching_integrity_engine"))
    return json({ error: "feature_unavailable" }, 404);
  try {
    const { id } = await params;
    z.string().uuid().parse(id);
    const payload = JSON.parse(
      new TextDecoder().decode(await readBoundedBody(request, 1024 * 1024)),
    );
    const repo = createNativeIntelligenceRepository(distributionPool());
    if (payload.action === "propose") {
      if (!nativeFeature(flags, "native_clip_candidates"))
        return json({ error: "feature_unavailable" }, 404);
      const { action: _, ...body } = payload;
      const command = nativeProposalCommandSchema.parse(body);
      // Operator imports are human proposals, never attributed to an uncalled AI vendor.
      command.analysis.provenance = {
        provider: "manual",
        model: "native-editor",
        promptVersion: "human-review-v1",
        schemaVersion: 1,
      };
      if (
        !nativeFeature(flags, "native_semantic_shadow") &&
        (command.analysis.annotations.some((a) => a.englishShadow) ||
          command.analysis.teachings.some((t) => t.englishShadow))
      )
        throw new Error("FEATURE_UNAVAILABLE");
      if (!nativeFeature(flags, "native_glossary") && command.analysis.glossaryVersionIds.length)
        throw new Error("FEATURE_UNAVAILABLE");
      return json(
        { id: await repo.propose(auth.context, id, command.requestId, command.analysis) },
        201,
      );
    }
    if (payload.action === "review") {
      if (!nativeFeature(flags, "native_language_review"))
        return json({ error: "feature_unavailable" }, 404);
      const { action: _, ...body } = payload;
      return json({
        review: await repo.review(auth.context, id, nativeReviewCommandSchema.parse(body)),
      });
    }
    return json({ error: "INVALID_REQUEST" }, 400);
  } catch (e) {
    return safeProblem(e);
  }
}
