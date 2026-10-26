import type { StudioOutput, StudioPackage, StudioSegment } from "./intelligent-content";
import { studioSourceRange, validateStudioMessagePassages } from "./studio-planner";
import { validateStudioOutputs } from "./studio-validation";
import { studioCanEdit } from "./studio-workflow";

export type StudioAdditionalMessage = Pick<
  StudioOutput,
  | "messageId"
  | "channel"
  | "format"
  | "language"
  | "title"
  | "body"
  | "rationale"
  | "sourceSegmentIds"
> & { captionCues: StudioSegment[] };

/** Append an unrendered teaching; existing files and their approval evidence stay byte-identical. */
export function appendStudioMessage(
  pkg: StudioPackage,
  input: StudioAdditionalMessage,
  id: string,
): StudioOutput[] {
  if (!studioCanEdit(pkg.status, ["content.create"])) throw new Error("INVALID_STUDIO_TRANSITION");
  if (!pkg.provenance) throw new Error("GENERATION_REQUIRED");
  if (!input.messageId || !["short", "reel", "video"].includes(input.format))
    throw new Error("INVALID_STUDIO_MESSAGE");
  const range = studioSourceRange(input.sourceSegmentIds, pkg.provenance.transcript, input.format);
  if (
    input.captionCues.length !== range.segments.length ||
    input.captionCues.some((cue, index) => {
      const source = range.segments[index];
      return (
        !source ||
        cue.id !== source.id ||
        cue.startMs !== source.startMs ||
        cue.endMs !== source.endMs ||
        !cue.text.trim() ||
        cue.text.length > 4000
      );
    })
  )
    throw new Error("INVALID_STUDIO_CAPTIONS");
  const output: StudioOutput = {
    id,
    messageId: input.messageId,
    channel: input.channel,
    format: input.format,
    language: input.language,
    title: input.title,
    body: input.body,
    rationale: input.rationale,
    sourceSegmentIds: [...input.sourceSegmentIds],
    captionCues: input.captionCues.map((cue) => ({ ...cue })),
    startMs: range.startMs,
    endMs: range.endMs,
    aspect: "9:16",
    included: true,
    asset: null,
    captions: [],
    warnings: [],
  };
  const outputs = [...pkg.outputs, output];
  validateStudioOutputs(outputs, {
    packageId: pkg.id,
    source: pkg.source,
    request: pkg.request,
    provenance: pkg.provenance,
  });
  validateStudioMessagePassages(outputs);
  return outputs;
}
