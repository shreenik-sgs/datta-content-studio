import { beforeEach, expect, it, vi } from "vitest";
import { StudioNoSuitableContentError } from "./studio-checkpoints";
import { StudioContentQualityError } from "./studio-content-review";
import { generateStudioPackage } from "./studio-generation";
import { StudioProviderError } from "./studio-provider-error";
import { type StudioWorkerInput, runStudioGenerationOnce, runStudioLoop } from "./studio-worker";
vi.mock("./studio-publishing", () => ({
  runStudioPublicationOnce: vi.fn().mockResolvedValue(false),
}));
vi.mock("./studio-generation", () => ({ generateStudioPackage: vi.fn() }));
vi.mock("./studio-preview-closing", () => ({ refreshStudioPreviewClosings: vi.fn() }));
const repository = {
  claimGeneration: vi.fn(),
  renewGeneration: vi.fn(),
  checkpointGeneration: vi.fn(),
  deferGeneration: vi.fn(),
  failGeneration: vi.fn(),
  completeGeneration: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  repository.claimGeneration.mockResolvedValue({ attempts: 1, checkpoint: {} });
  repository.deferGeneration.mockResolvedValue(true);
});
const input = () =>
  ({
    repository,
    store: {},
    env: {},
    isTest: true,
    workerId: "synthetic",
    signal: new AbortController().signal,
  }) as unknown as StudioWorkerInput;
it("records a suitability explanation atomically without retrying or approving an empty result", async () => {
  const excludedChannels = [
    { channel: "youtube" as const, reason: "Music only; no complete teaching." },
  ];
  vi.mocked(generateStudioPackage).mockRejectedValue(
    new StudioNoSuitableContentError(excludedChannels),
  );
  await runStudioGenerationOnce(input());
  expect(repository.failGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_NO_SUITABLE_CHANNELS",
    expect.objectContaining({ excludedChannels }),
  );
  expect(repository.checkpointGeneration).not.toHaveBeenCalled();
  expect(repository.completeGeneration).not.toHaveBeenCalled();
  expect(repository.deferGeneration).not.toHaveBeenCalled();
});
it("contains an unexpected recording error, hides raw diagnostics and processes the next recording", async () => {
  vi.mocked(generateStudioPackage)
    .mockRejectedValueOnce(new Error("Upstream payload contained a private token"))
    .mockResolvedValueOnce({ outputs: [], provenance: {} } as never);
  const onError = vi.fn();
  await runStudioGenerationOnce({ ...input(), onError });
  await runStudioGenerationOnce({ ...input(), onError });
  expect(repository.failGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "GENERATION_FAILED",
    expect.objectContaining({ errorCode: "GENERATION_FAILED" }),
  );
  expect(onError).toHaveBeenCalledWith("GENERATION_FAILED");
  expect(repository.completeGeneration).toHaveBeenCalledOnce();
});
it("does not overwrite another worker's results after losing the lease", async () => {
  vi.mocked(generateStudioPackage).mockRejectedValue(new Error("STUDIO_LEASE_LOST"));
  await runStudioGenerationOnce(input());
  expect(repository.failGeneration).not.toHaveBeenCalled();
  expect(repository.completeGeneration).not.toHaveBeenCalled();
});
it("records safe failure locations without logging raw provider messages or tokens", async () => {
  const error = new TypeError("Private token must never be logged");
  error.stack =
    "TypeError: Private token must never be logged\n at parse (/repo/apps/distribution-worker/src/studio-intelligence.ts:123:4)\n at https://example.test/?token=secret";
  vi.mocked(generateStudioPackage).mockRejectedValue(error);
  const onFailureDiagnostic = vi.fn();
  await runStudioGenerationOnce({ ...input(), onFailureDiagnostic });
  expect(onFailureDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      code: "GENERATION_FAILED",
      errorType: "TypeError",
      sourceLocations: ["apps/distribution-worker/src/studio-intelligence.ts:123:4"],
    }),
  );
  expect(JSON.stringify(onFailureDiagnostic.mock.calls)).not.toMatch(
    /Private token|example.test|secret/,
  );
});
it("queues a timed retry for a drafting rate limit while retaining checkpoints", async () => {
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.set("transcript", "a".repeat(64), { synthetic: true });
    await checkpoints?.progress({ phase: "drafting", provider: "gemini", completed: 2, total: 24 });
    throw new StudioProviderError("STUDIO_PROVIDER_RATE_LIMITED", 120000);
  });
  await runStudioGenerationOnce(input());
  expect(repository.deferGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_PROVIDER_RATE_LIMITED",
    120000,
    expect.objectContaining({ completed: 2 }),
  );
  expect(repository.failGeneration).not.toHaveBeenCalled();
});
it.each(["STUDIO_PROVIDER_QUOTA_EXHAUSTED", "STUDIO_PROVIDER_SPEND_CAP_REACHED"])(
  "does not automatically retry %s",
  async (code) => {
    vi.mocked(generateStudioPackage).mockRejectedValue(new StudioProviderError(code));
    await runStudioGenerationOnce(input());
    expect(repository.deferGeneration).not.toHaveBeenCalled();
    expect(repository.failGeneration).toHaveBeenCalledWith(
      expect.anything(),
      code,
      expect.objectContaining({ errorCode: code }),
    );
  },
);

it.each([
  ["drafting", "STUDIO_PROVIDER_ABORTED"],
  ["rendering", "RENDER_PROCESS_FAILED"],
  ["rendering", "RENDER_CANCELLED"],
] as const)("resumes saved %s work after a service restart (%s)", async (phase, code) => {
  const controller = new AbortController();
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.progress({ phase, provider: "gemini", completed: 1, total: 2 });
    controller.abort();
    throw Error(code);
  });
  await runStudioGenerationOnce({ ...input(), signal: controller.signal });
  expect(repository.deferGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_PROVIDER_ABORTED",
    30000,
    expect.objectContaining({ phase, completed: 1 }),
  );
  expect(repository.failGeneration).not.toHaveBeenCalled();
});

it.each([false, true])(
  "restarts transcription only with explicit resumable evidence: %s",
  async (transcriptionResumable) => {
    const controller = new AbortController();
    vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
      await checkpoints?.progress({
        phase: "transcription",
        provider: "sarvam",
        completed: 0,
        total: 1,
      });
      controller.abort();
      throw new StudioProviderError("STUDIO_PROVIDER_ABORTED", 0, false, transcriptionResumable);
    });
    await runStudioGenerationOnce({ ...input(), signal: controller.signal });
    expect(repository.deferGeneration).toHaveBeenCalledTimes(transcriptionResumable ? 1 : 0);
    expect(repository.failGeneration).toHaveBeenCalledTimes(transcriptionResumable ? 0 : 1);
  },
);

it("does not hide an AI quality failure when shutdown happens at the same time", async () => {
  const controller = new AbortController();
  vi.mocked(generateStudioPackage).mockImplementation(async () => {
    controller.abort();
    throw new StudioContentQualityError([]);
  });
  await runStudioGenerationOnce({ ...input(), signal: controller.signal });
  expect(repository.deferGeneration).not.toHaveBeenCalled();
  expect(repository.failGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_VIDEO_REVIEW_REQUIRED",
    expect.objectContaining({ errorCode: "STUDIO_VIDEO_REVIEW_REQUIRED" }),
  );
});
it("does not recreate a transcription job after an ambiguous creation failure", async () => {
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.progress({
      phase: "transcription",
      provider: "sarvam",
      completed: 0,
      total: 1,
    });
    throw new StudioProviderError("STUDIO_PROVIDER_UNAVAILABLE");
  });
  await runStudioGenerationOnce(input());
  expect(repository.deferGeneration).not.toHaveBeenCalled();
});

it("holds an incomplete video out of review and saves the specific finding for the curator", async () => {
  const checks = [
    {
      channel: "youtube",
      language: "en",
      openingComplete: true,
      endingComplete: false,
      contextComplete: false,
      attributionCorrect: true,
      captionsFaithful: false,
      copySupported: true,
      reason: "The answer is in the omitted next segment; the caption invents it.",
    },
  ];
  vi.mocked(generateStudioPackage).mockRejectedValue(new StudioContentQualityError(checks));
  await runStudioGenerationOnce(input());
  expect(repository.completeGeneration).not.toHaveBeenCalled();
  expect(repository.deferGeneration).not.toHaveBeenCalled();
  expect(repository.failGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_VIDEO_REVIEW_REQUIRED",
    expect.objectContaining({ reviewIssues: checks }),
  );
  expect(repository.failGeneration).toHaveBeenCalledWith(
    expect.anything(),
    "STUDIO_VIDEO_REVIEW_REQUIRED",
    expect.objectContaining({ errorCode: "STUDIO_VIDEO_REVIEW_REQUIRED" }),
  );
});

it.each(["created", "starting", "started"])(
  "resumes a saved Sarvam job at %s without creating a replacement",
  async (stage) => {
    vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
      await checkpoints?.set("sarvam-job", "a".repeat(64), { jobId: "same-job", stage });
      await checkpoints?.progress({
        phase: "transcription",
        provider: "sarvam",
        completed: 0,
        total: 1,
      });
      throw new StudioProviderError("STUDIO_PROVIDER_UNAVAILABLE", 0, false, true);
    });
    await runStudioGenerationOnce(input());
    expect(repository.deferGeneration).toHaveBeenCalledTimes(1);
    expect(repository.failGeneration).not.toHaveBeenCalled();
  },
);
it("retries a transcription connection failure only when no request was sent", async () => {
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.progress({
      phase: "transcription",
      provider: "sarvam",
      completed: 0,
      total: 1,
    });
    throw new StudioProviderError("STUDIO_PROVIDER_UNAVAILABLE", 0, true);
  });
  await runStudioGenerationOnce(input());
  expect(repository.deferGeneration).toHaveBeenCalledTimes(1);
});

it("does not use an earlier file's checkpoint to retry an uncertain transcription for another file", async () => {
  repository.claimGeneration.mockResolvedValue({
    attempts: 1,
    checkpoint: {
      "correction:old:sarvam-job": {
        fingerprint: "a".repeat(64),
        value: { jobId: "old-job", stage: "started" },
      },
    },
  });
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.progress({
      phase: "transcription",
      provider: "sarvam",
      completed: 0,
      total: 1,
    });
    throw new StudioProviderError("STUDIO_PROVIDER_UNAVAILABLE");
  });
  await runStudioGenerationOnce(input());
  expect(repository.deferGeneration).not.toHaveBeenCalled();
});

it("runs five distinct generation slots but only one publication loop", async () => {
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const workerIds = new Set<string>();
  repository.claimGeneration.mockImplementation(async ({ workerId }) => {
    workerIds.add(workerId);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    controller.abort();
    return null;
  });
  const { runStudioPublicationOnce } = await import("./studio-publishing");
  vi.mocked(runStudioPublicationOnce).mockResolvedValue(false);
  await runStudioLoop({
    ...input(),
    env: { STUDIO_GENERATION_CONCURRENCY: "5" },
    signal: controller.signal,
  });
  expect(peak).toBe(5);
  expect(workerIds.size).toBe(5);
  expect(runStudioPublicationOnce).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "only retries a transient authority interruption, never a denied renewal (%s)",
  async (unavailable) => {
    vi.useFakeTimers();
    try {
      repository.renewGeneration.mockImplementation(async () => {
        if (unavailable) throw Error("OPERATOR_AUTHORITY_UNAVAILABLE");
        return false;
      });
      vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints, signal }) => {
        await checkpoints?.progress({
          phase: "rendering",
          provider: "local",
          completed: 1,
          total: 2,
        });
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(Error("RENDER_CANCELLED")), {
            once: true,
          }),
        );
        throw Error("UNREACHABLE");
      });
      const run = runStudioGenerationOnce(input());
      await vi.advanceTimersByTimeAsync(30001);
      await run;
      expect(repository.deferGeneration).toHaveBeenCalledTimes(unavailable ? 1 : 0);
      expect(repository.completeGeneration).not.toHaveBeenCalled();
      if (unavailable)
        expect(repository.deferGeneration).toHaveBeenCalledWith(
          expect.anything(),
          "OPERATOR_AUTHORITY_UNAVAILABLE",
          60000,
          expect.objectContaining({ completed: 1 }),
        );
    } finally {
      vi.useRealTimers();
    }
  },
);
it("does not retry an uncertain transcription when authority is unavailable", async () => {
  vi.mocked(generateStudioPackage).mockImplementation(async ({ checkpoints }) => {
    await checkpoints?.progress({
      phase: "transcription",
      provider: "sarvam",
      completed: 0,
      total: 1,
    });
    throw Error("OPERATOR_AUTHORITY_UNAVAILABLE");
  });
  await runStudioGenerationOnce(input());
  expect(repository.deferGeneration).not.toHaveBeenCalled();
  expect(repository.completeGeneration).not.toHaveBeenCalled();
});
