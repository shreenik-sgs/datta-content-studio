import type { StudioOutput, StudioTranscript } from "./intelligent-content";
import { type StudioPlannedOutput, studioSourceRange } from "./studio-planner";

export const STUDIO_DISCOVERY_POLICY = "section-discovery-v1" as const;
export type StudioDiscoverySection = {
  index: number;
  startMs: number;
  endMs: number;
  contextStartMs: number;
  contextEndMs: number;
};
export type StudioDiscoveryCoverage = {
  policy: typeof STUDIO_DISCOVERY_POLICY;
  sections: (StudioDiscoverySection & {
    candidates: number;
    accepted: number;
    duplicates: number;
    reason?: string;
  })[];
  completedAt: string;
};
export type StudioDiscoveryDecision = { key: string; duplicateOf: string | null; reason: string };
export function validateStudioDiscoveryDecisions(
  value: unknown,
  candidateCount: number,
  retainedCount: number,
): StudioDiscoveryDecision[] {
  const decisions = (value as { decisions?: StudioDiscoveryDecision[] } | null)?.decisions;
  const seen = new Set(Array.from({ length: retainedCount }, (_, i) => `retained-${i}`));
  if (!Array.isArray(decisions) || decisions.length !== candidateCount)
    throw Error("STUDIO_DISCOVERY_REVIEW_INVALID");
  for (const [index, decision] of decisions.entries()) {
    if (
      !decision ||
      decision.key !== `candidate-${index}` ||
      typeof decision.reason !== "string" ||
      !decision.reason.trim() ||
      decision.reason.length > 3000 ||
      (decision.duplicateOf !== null &&
        (typeof decision.duplicateOf !== "string" || !seen.has(decision.duplicateOf)))
    )
      throw Error("STUDIO_DISCOVERY_REVIEW_INVALID");
    seen.add(decision.key);
  }
  return decisions;
}

export function validateStudioDiscoveryCoverage(
  value: StudioDiscoveryCoverage,
  transcript: StudioTranscript,
): void {
  const expected = studioDiscoverySections(transcript);
  if (
    !value ||
    value.policy !== STUDIO_DISCOVERY_POLICY ||
    !Array.isArray(value.sections) ||
    value.sections.length !== expected.length ||
    !Number.isFinite(Date.parse(value.completedAt))
  )
    throw Error("INVALID_STUDIO_DISCOVERY_COVERAGE");
  for (const [i, section] of value.sections.entries()) {
    if (
      !section ||
      Object.entries(expected[i] ?? {}).some(
        ([key, v]) => section[key as keyof StudioDiscoverySection] !== v,
      ) ||
      [section.candidates, section.accepted, section.duplicates].some(
        (n) => !Number.isSafeInteger(n) || n < 0,
      ) ||
      section.accepted + section.duplicates > section.candidates ||
      (section.reason !== undefined &&
        (typeof section.reason !== "string" || section.reason.length > 4000))
    )
      throw Error("INVALID_STUDIO_DISCOVERY_COVERAGE");
  }
}

/** Every segment start belongs to one five-minute section; context never cuts source speech. */
export function studioDiscoverySections(transcript: StudioTranscript): StudioDiscoverySection[] {
  if (
    !Number.isSafeInteger(transcript.durationMs) ||
    transcript.durationMs < 1 ||
    transcript.durationMs > 86400000
  )
    throw Error("INVALID_STUDIO_TRANSCRIPT");
  const sections: StudioDiscoverySection[] = [];
  for (let startMs = 0; startMs < transcript.durationMs; startMs += 300000) {
    const endMs = Math.min(startMs + 300000, transcript.durationMs);
    // Empty/silent intervals need no paid AI request. Every spoken segment is still covered.
    if (!transcript.segments.some((s) => s.startMs >= startMs && s.startMs < endMs)) continue;
    sections.push({
      index: sections.length,
      startMs,
      endMs,
      contextStartMs: Math.max(0, startMs - 180000),
      contextEndMs: Math.min(transcript.durationMs, endMs + 180000),
    });
  }
  return sections;
}

export function studioDiscoveryTranscript(
  transcript: StudioTranscript,
  section: StudioDiscoverySection,
): StudioTranscript {
  return {
    ...transcript,
    segments: transcript.segments.filter(
      (s) => s.endMs > section.contextStartMs && s.startMs < section.contextEndMs,
    ),
  };
}

/** Overlap is removed before rendering; one speech passage must not become several extra Shorts. */
export function studioDiscoveryOverlaps(
  candidate: StudioPlannedOutput,
  retained: StudioPlannedOutput[],
  transcript: StudioTranscript,
): boolean {
  const a = studioSourceRange(
    candidate.sourceSegmentIds,
    transcript,
    candidate.format,
    candidate.sourceTrim,
  );
  return retained.some((other) => {
    if (!["short", "reel"].includes(other.format)) return false;
    const b = studioSourceRange(other.sourceSegmentIds, transcript, other.format, other.sourceTrim);
    return Math.min(a.endMs, b.endMs) > Math.max(a.startMs, b.startMs);
  });
}

/** Discovery may append files, never rewrite a previous file, edit or review. */
export function assertStudioDiscoveryIsolation(
  before: StudioOutput[],
  after: StudioOutput[],
): void {
  if (after.length < before.length || new Set(after.map((o) => o.id)).size !== after.length)
    throw Error("STUDIO_DISCOVERY_ISOLATION_REQUIRED");
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry,
    );
  for (const old of before) {
    const current = after.find((o) => o.id === old.id);
    if (!current || stable(current) !== stable(old))
      throw Error("STUDIO_DISCOVERY_ISOLATION_REQUIRED");
  }
}
