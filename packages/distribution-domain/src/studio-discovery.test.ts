import { expect, it } from "vitest";
import type { StudioOutput, StudioTranscript } from "./intelligent-content";
import {
  assertStudioDiscoveryIsolation,
  studioDiscoverySections,
  studioDiscoveryTranscript,
  validateStudioDiscoveryCoverage,
  validateStudioDiscoveryDecisions,
} from "./studio-discovery";

const transcript: StudioTranscript = {
  language: "en",
  durationMs: 650000,
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
  segments: [
    { id: "first", startMs: 0, endMs: 20000, text: "A complete teaching." },
    {
      id: "boundary",
      startMs: 299000,
      endMs: 320000,
      text: "This complete thought crosses a section boundary.",
    },
    { id: "next", startMs: 320000, endMs: 360000, text: "Another lesson." },
    { id: "last", startMs: 640000, endMs: 650000, text: "The final lesson." },
  ],
};
it("owns every spoken segment once, preserves absolute timing, and retains boundary context", () => {
  const sections = studioDiscoverySections(transcript);
  expect(sections).toHaveLength(3);
  for (const s of transcript.segments)
    expect(sections.filter((w) => s.startMs >= w.startMs && s.startMs < w.endMs)).toHaveLength(1);
  const first = sections[0];
  if (!first) throw Error("Missing fixture section");
  expect(
    studioDiscoveryTranscript(transcript, first).segments.find((s) => s.id === "boundary"),
  ).toEqual(transcript.segments[1]);
  expect(sections.at(-1)?.endMs).toBe(650000);
  expect(transcript.segments.at(-1)?.startMs).toBe(640000);
});
it("rejects missing coverage and forged completion counts", () => {
  const value = {
    policy: "section-discovery-v1" as const,
    completedAt: new Date().toISOString(),
    sections: studioDiscoverySections(transcript).map((s) => ({
      ...s,
      candidates: 2,
      accepted: 1,
      duplicates: 1,
    })),
  };
  expect(() => validateStudioDiscoveryCoverage(value, transcript)).not.toThrow();
  expect(() =>
    validateStudioDiscoveryCoverage({ ...value, sections: value.sections.slice(1) }, transcript),
  ).toThrow();
  expect(() =>
    validateStudioDiscoveryCoverage(
      { ...value, sections: value.sections.map((s) => ({ ...s, accepted: 10 })) },
      transcript,
    ),
  ).toThrow();
});
it("refuses duplicate screening that omits a candidate or references itself, a future candidate or an unknown file", () => {
  expect(
    validateStudioDiscoveryDecisions(
      {
        decisions: [
          { key: "candidate-0", duplicateOf: "retained-0", reason: "Same practical lesson." },
        ],
      },
      1,
      1,
    ),
  ).toHaveLength(1);
  for (const duplicateOf of ["candidate-0", "candidate-1", "retained-9", undefined])
    expect(() =>
      validateStudioDiscoveryDecisions(
        { decisions: [{ key: "candidate-0", duplicateOf, reason: "Repeated." }] },
        1,
        1,
      ),
    ).toThrow("STUDIO_DISCOVERY_REVIEW_INVALID");
  expect(() => validateStudioDiscoveryDecisions({ decisions: [] }, 1, 1)).toThrow();
});
it("allows only appended files and protects every existing edit and evidence field", () => {
  const original = {
    id: "kept",
    title: "Edited title",
    mediaEdits: { trimStartMs: 2000 },
    asset: { sha256: "reviewed" },
  } as unknown as StudioOutput;
  const extra = { ...original, id: "new" };
  expect(() =>
    assertStudioDiscoveryIsolation([original], [structuredClone(original), extra]),
  ).not.toThrow();
  for (const after of [[extra], [original, original], [{ ...original, title: "Replaced" }, extra]])
    expect(() => assertStudioDiscoveryIsolation([original], after)).toThrow(
      "STUDIO_DISCOVERY_ISOLATION_REQUIRED",
    );
});
