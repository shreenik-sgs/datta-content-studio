import { describe, expect, it } from "vitest";
import {
  editorialReviewCommandSchema,
  glossaryCommandSchema,
  glossaryEntrySchema,
  manualTranscriptCommandSchema,
  quoteCandidateInputSchema,
  transcriptCorrectionSchema,
  transcriptVersionSchema,
} from "./index";
const id = "0193fd85-5213-7510-8139-981af6339219";
const version = "0193fd85-5213-7510-8139-981af6339220";
const transcript = {
  id,
  parentVersionId: null,
  number: 1,
  masterVersionId: version,
  sourceSha256: "a".repeat(64),
  language: "sa",
  revision: 1,
  durationMs: 10000,
  segments: [
    {
      id: "first",
      startMs: 0,
      endMs: 5000,
      originalText: "Jaya Guru Datta",
      displayText: "Jaya Guru Datta",
    },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-v1",
  },
  review: null,
};
describe("DS-DIST-R2 strict editorial contracts", () => {
  it("DS-DIST-R2-SOURCE requires valid lineage, timecodes and recipe provenance", () => {
    expect(transcriptVersionSchema.parse(transcript)).toEqual(transcript);
    expect(() =>
      transcriptVersionSchema.parse({ ...transcript, email: "devotee@example.com" }),
    ).toThrow();
    expect(() =>
      transcriptVersionSchema.parse({
        ...transcript,
        provenance: { ...transcript.provenance, provider: "generated" },
      }),
    ).toThrow();
    expect(() =>
      transcriptVersionSchema.parse({
        ...transcript,
        segments: [{ ...transcript.segments[0], endMs: 20000 }],
      }),
    ).toThrow();
  });
  it("DS-DIST-R2-REVIEW takes only the action and optimistic revision, never client-set reviewer identity", () => {
    expect(
      editorialReviewCommandSchema.parse({ expectedRevision: 1, decision: "APPROVED" }),
    ).toMatchObject({ decision: "APPROVED" });
    expect(() =>
      editorialReviewCommandSchema.parse({
        expectedRevision: 1,
        decision: "APPROVED",
        reviewerId: "forged",
      }),
    ).toThrow();
    expect(() =>
      transcriptCorrectionSchema.parse({ expectedRevision: 1, corrections: [] }),
    ).toThrow();
  });
  it("DS-DIST-R2-QUOTE refuses client approvals and requires exact segment spans", () => {
    const draft = {
      transcriptVersionId: id,
      transcriptRevision: 1,
      segmentIds: ["first"],
      startMs: 0,
      endMs: 5000,
      text: "Jaya Guru Datta",
      kind: "EXACT_QUOTE",
    };
    expect(quoteCandidateInputSchema.parse(draft)).toEqual(draft);
    expect(() =>
      quoteCandidateInputSchema.parse({ ...draft, review: { decision: "APPROVED" } }),
    ).toThrow();
    expect(() => quoteCandidateInputSchema.parse({ ...draft, endMs: -1 })).toThrow();
    expect(() => quoteCandidateInputSchema.parse({ ...draft, segmentIds: [] })).toThrow();
  });
  it("DS-DIST-R2-GLOSSARY bounds and trims manual terms", () => {
    expect(
      glossaryEntrySchema.parse({ id, term: " Datta ", preferred: "Datta", language: "sa" }).term,
    ).toBe("Datta");
    expect(() =>
      glossaryEntrySchema.parse({ id, term: "", preferred: "Datta", language: "sa" }),
    ).toThrow();
  });
});

it("DS-DIST-R2-SOURCE manual transcript command pins the source version and bounds ordered segments", () => {
  const command = {
    expectedSourceVersionId: version,
    language: "sa",
    durationMs: 10000,
    segments: transcript.segments,
  };
  expect(manualTranscriptCommandSchema.parse(command)).toEqual(command);
  expect(() =>
    manualTranscriptCommandSchema.parse({ ...command, provenance: transcript.provenance }),
  ).toThrow();
  expect(() =>
    manualTranscriptCommandSchema.parse({
      ...command,
      segments: [{ ...transcript.segments[0], endMs: 12000 }],
    }),
  ).toThrow();
  expect(() => manualTranscriptCommandSchema.parse({ ...command, segments: [] })).toThrow();
  expect(
    glossaryCommandSchema.parse({ term: "Datta", preferred: "Datta", language: "sa" }),
  ).toMatchObject({ term: "Datta" });
  expect(() =>
    glossaryCommandSchema.parse({ id, term: "Datta", preferred: "Datta", language: "sa" }),
  ).toThrow();
});
