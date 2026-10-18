import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRITY_CHECKS, type NativeAnalysis } from "@satsang/distribution-domain";
import { describe, expect, it, vi } from "vitest";
import { runNativeBatch } from "./native-batch";
import type { NativeSemanticInput } from "./native-semantic";
const transcript: NativeSemanticInput["transcript"] = {
  id: "11111111-1111-4111-8111-111111111111",
  parentVersionId: null,
  number: 1,
  masterVersionId: "22222222-2222-4222-8222-222222222222",
  sourceSha256: "a".repeat(64),
  language: "te",
  revision: 2,
  durationMs: 5000,
  segments: [
    { id: "s", startMs: 0, endMs: 5000, originalText: "కృత్రిమ పరీక్ష", displayText: "కృత్రిమ పరీక్ష" },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-v1",
  },
  review: {
    decision: "APPROVED",
    revision: 2,
    reviewerId: "local",
    reviewedAt: "2026-10-03T12:00:00Z",
  },
};
const input: NativeSemanticInput = {
  transcript,
  annotations: [
    {
      segmentId: "s",
      confidence: 0.7,
      speakerId: "fixture",
      speakerName: "Synthetic speaker",
      languageSpans: [{ startMs: 0, endMs: 5000, language: "te" }],
      words: [],
      englishShadow: null,
      uncertainty: ["Synthetic sample"],
    },
  ],
  glossary: [],
  privacyClass: "PUBLIC",
  authorizationBasis: "Synthetic contract test only",
  semanticShadow: true,
};
const result = {
  shadows: [{ segmentId: "s", englishShadow: "Synthetic test" }],
  teachings: [
    {
      id: "t",
      segmentIds: ["s"],
      kind: "conclusion",
      nativeSummary: "కృత్రిమ పరీక్ష",
      englishShadow: "Synthetic test",
      requiredContextIds: [],
    },
  ],
  candidates: [
    {
      id: "c",
      segmentIds: ["s"],
      startMs: 0,
      endMs: 5000,
      rationale: "Synthetic full segment",
      attributedSpeakerId: "fixture",
      checks: INTEGRITY_CHECKS.map((check) => ({
        check,
        status: "PASS",
        evidence: "Synthetic test",
        segmentIds: ["s"],
      })),
      scores: {
        fidelity: 1,
        selfContainment: 1,
        contextCompleteness: 1,
        significance: 1,
        clarity: 1,
        accessibility: 1,
        visualSuitability: 1,
        hook: 1,
      },
    },
  ],
};

const analysis: NativeAnalysis = {
  schemaVersion: 1,
  transcriptVersionId: transcript.id,
  transcriptRevision: transcript.revision,
  sourceSha256: transcript.sourceSha256,
  language: "te",
  glossaryVersionIds: [],
  annotations: input.annotations,
  teachings: result.teachings as NativeAnalysis["teachings"],
  candidates: result.candidates as NativeAnalysis["candidates"],
  provenance: { provider: "synthetic", model: "test", promptVersion: "test", schemaVersion: 1 },
};
describe("bounded native evaluation batch", () => {
  it("resumes outputs without duplicate calls and refuses changed source identity", async () => {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "native-batch-"));
    try {
      const path = join(dir, "input.json");
      await writeFile(path, JSON.stringify(input));
      const adapter = { analyze: vi.fn().mockResolvedValue(analysis) };
      const jobs = [{ id: "synthetic", inputPath: path }];
      expect((await runNativeBatch(jobs, dir, adapter)).processed).toBe(1);
      expect((await runNativeBatch(jobs, dir, adapter)).processed).toBe(0);
      expect(adapter.analyze).toHaveBeenCalledTimes(1);
      await writeFile(path, JSON.stringify({ ...input, authorizationBasis: "changed" }));
      await expect(runNativeBatch(jobs, dir, adapter)).rejects.toThrow(
        "NATIVE_BATCH_SOURCE_CHANGED",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("persists attempts, caps retries and excludes vendor failure text", async () => {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "native-batch-"));
    try {
      const path = join(dir, "input.json");
      await writeFile(path, JSON.stringify(input));
      const adapter = { analyze: vi.fn().mockRejectedValue(new Error("private provider body")) };
      for (let i = 0; i < 4; i++)
        await runNativeBatch([{ id: "synthetic", inputPath: path }], dir, adapter);
      expect(adapter.analyze).toHaveBeenCalledTimes(3);
      const stored = await readFile(join(dir, "synthetic.status.json"), "utf8");
      expect(stored).not.toContain("private provider body");
      expect(JSON.parse(stored)).toMatchObject({ attempts: 3, status: "FAILED" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
