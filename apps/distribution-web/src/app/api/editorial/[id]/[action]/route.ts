import {
  editorialReviewCommandSchema,
  glossaryCommandSchema,
  manualTranscriptCommandSchema,
  quoteCandidateInputSchema,
  transcriptCorrectionSchema,
} from "@satsang/distribution-contracts";
import type { DistributionCapability } from "@satsang/distribution-domain";
import { z } from "zod";
import { editorialRepository } from "../../../../../lib/editorial-runtime";
import { json, readBoundedBody, safeProblem } from "../../../../../lib/http";
import { access } from "../../../../../lib/runtime";

const permissions: Record<string, DistributionCapability> = {
  transcript: "content.create",
  correct: "content.create",
  review: "content.review",
  quote: "content.create",
  "review-quote": "content.review",
  glossary: "content.review",
};
const manual = {
  provider: "manual",
  model: null,
  promptVersion: null,
  schemaVersion: 1,
  recipeVersion: "human-editorial-v1",
};
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  const auth = await access(request, permissions[action]);
  if (!auth.ok) return auth.response;
  try {
    if (!Object.hasOwn(permissions, action)) return json({ error: "NOT_FOUND" }, 404);
    z.string().uuid().parse(id);
    const bytes = await readBoundedBody(request, 1024 * 1024);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("INVALID_REQUEST");
    }
    const repo = editorialRepository();
    if (action === "transcript")
      return json(
        {
          transcript: await repo.createTranscript(auth.context, id, {
            ...manualTranscriptCommandSchema.parse(body),
            provenance: manual,
          }),
        },
        201,
      );
    if (action === "correct")
      return json(
        {
          transcript: await repo.correctTranscript(
            auth.context,
            id,
            transcriptCorrectionSchema.parse(body),
          ),
        },
        201,
      );
    if (action === "review")
      return json({
        transcript: await repo.reviewTranscript(
          auth.context,
          id,
          editorialReviewCommandSchema.parse(body),
        ),
      });
    if (action === "quote") {
      const command = quoteCandidateInputSchema.parse(body);
      if (command.transcriptVersionId !== id) throw new Error("SOURCE_MISMATCH");
      return json(
        { quote: await repo.createQuote(auth.context, { ...command, provenance: manual }) },
        201,
      );
    }
    if (action === "review-quote")
      return json({
        quote: await repo.reviewQuote(auth.context, id, editorialReviewCommandSchema.parse(body)),
      });
    if (action === "glossary") {
      await auth.repo.get(auth.context, id);
      return json(
        { glossary: await repo.addGlossary(auth.context, glossaryCommandSchema.parse(body)) },
        201,
      );
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return safeProblem(error);
  }
}
