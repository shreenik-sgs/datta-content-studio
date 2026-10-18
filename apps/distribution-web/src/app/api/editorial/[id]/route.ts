import { effectiveQuoteDecision } from "@satsang/distribution-domain";
import { z } from "zod";
import { editorialRepository } from "../../../../lib/editorial-runtime";
import { json, safeProblem } from "../../../../lib/http";
import { access } from "../../../../lib/runtime";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    z.string().uuid().parse(id);
    const content = await auth.repo.get(auth.context, id);
    const repository = editorialRepository();
    const [transcripts, quotes, glossary] = await Promise.all([
      repository.listTranscripts(auth.context, id),
      repository.listQuotes(auth.context, id),
      repository.listGlossary(auth.context, content.language),
    ]);
    const transcriptById = new Map(transcripts.map((transcript) => [transcript.id, transcript]));
    const superseded = new Set(transcripts.map((transcript) => transcript.parentVersionId));
    const quoteEligibility = Object.fromEntries(
      quotes.map((quote) => {
        const transcript = transcriptById.get(quote.transcriptVersionId);
        return [
          quote.id,
          transcript
            ? effectiveQuoteDecision({
                quote,
                transcript,
                currentMasterVersionId: content.currentVersion.id,
                sourceWithdrawn: content.state === "WITHDRAWN",
                transcriptSuperseded: superseded.has(transcript.id),
              })
            : { allowed: false, reason: "TRANSCRIPT_NOT_APPROVED" },
        ];
      }),
    );
    return json({ version: 1, transcripts, quotes, glossary, quoteEligibility });
  } catch (error) {
    return safeProblem(error);
  }
}
