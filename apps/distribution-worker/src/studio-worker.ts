import { setTimeout as pause } from "node:timers/promises";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { createIntelligentContentRepository } from "@satsang/distribution-db";
import type { StudioGenerationProgress } from "@satsang/distribution-domain";
import { studioCapacity } from "./studio-capacity.js";
import { StudioNoSuitableContentError } from "./studio-checkpoints.js";
import { StudioClosingPreservationError } from "./studio-closing-refresh.js";
import { StudioContentQualityError } from "./studio-content-review.js";
import { generateStudioPackage } from "./studio-generation.js";
import { StudioProviderError } from "./studio-provider-error.js";
import { runStudioPublicationOnce } from "./studio-publishing.js";

export type StudioWorkerInput = {
  repository: ReturnType<typeof createIntelligentContentRepository>;
  store: PrivateAssetStore;
  isTest: boolean;
  workerId: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  onError?: (code: string) => void;
};
export async function runStudioGenerationOnce(input: StudioWorkerInput): Promise<boolean> {
  const claim = await input.repository.claimGeneration({
    isTest: input.isTest,
    workerId: input.workerId,
  });
  if (!claim) return false;
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  let renewing = false;
  let authorityInterrupted = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void input.repository
      .renewGeneration(claim)
      .then((valid) => {
        if (!valid) stop.abort();
      })
      .catch((error) => {
        authorityInterrupted =
          error instanceof Error && error.message === "OPERATOR_AUTHORITY_UNAVAILABLE";
        stop.abort();
      })
      .finally(() => {
        renewing = false;
      });
  }, 30000);
  heartbeat.unref();
  const saved = structuredClone(claim.checkpoint ?? {});
  let progress: StudioGenerationProgress = {
    phase: "source",
    provider: "local",
    completed: 0,
    total: 1,
  };
  try {
    const result = await generateStudioPackage({
      claim,
      store: input.store,
      env: input.env,
      signal,
      checkpoints: {
        get: <T>(key: string, fingerprint: string) =>
          saved[key]?.fingerprint === fingerprint
            ? (structuredClone(saved[key]?.value) as T)
            : undefined,
        set: async (key, fingerprint, value) => {
          await input.repository.checkpointGeneration(claim, { key, fingerprint, value });
          saved[key] = { fingerprint, value: structuredClone(value) };
        },
        progress: async (value) => {
          progress = value;
          await input.repository.checkpointGeneration(claim, { progress: value });
        },
      },
    });
    await input.repository.completeGeneration(claim, result);
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
        ? error.message
        : "GENERATION_FAILED";
    const retryDelay = error instanceof StudioProviderError ? error.retryAfterMs : 0;
    // Resume the same saved job at any setup stage; never recreate an uncertain creation POST.
    const resumable =
      progress.phase !== "transcription" ||
      (error instanceof StudioProviderError &&
        (error.requestNotSent || error.transcriptionResumable));
    // Stop immediately when fresh authority cannot be checked. A timed retry resumes
    // the SAME durable job only after claimGeneration checks the current role again.
    // A negative renewal (revocation/lost lease) and uncertain transcription are not retries.
    if (
      resumable &&
      (code === "OPERATOR_AUTHORITY_UNAVAILABLE" ||
        (authorityInterrupted && ["RENDER_CANCELLED", "STUDIO_PROVIDER_ABORTED"].includes(code))) &&
      (await input.repository.deferGeneration(
        claim,
        "OPERATOR_AUTHORITY_UNAVAILABLE",
        60000,
        progress,
      ))
    )
      return true;
    // A service replacement is not a failed source. Resume only known-safe work;
    // never repeat an uncertain transcription creation or reclaim a lost lease.
    if (
      input.signal.aborted &&
      !stop.signal.aborted &&
      resumable &&
      [
        "STUDIO_PROVIDER_ABORTED",
        "GENERATION_TIMEOUT",
        "GENERATION_FAILED",
        "RENDER_PROCESS_FAILED",
        "RENDER_CANCELLED",
      ].includes(code) &&
      (await input.repository.deferGeneration(claim, "STUDIO_PROVIDER_ABORTED", 30000, progress))
    )
      return true;
    if (
      resumable &&
      retryDelay <= 3600000 &&
      [
        "STUDIO_PROVIDER_RATE_LIMITED",
        "STUDIO_PROVIDER_UNAVAILABLE",
        "STUDIO_PROVIDER_TIMEOUT",
      ].includes(code) &&
      (await input.repository.deferGeneration(
        claim,
        code,
        Math.max(retryDelay, claim.attempts * 60000),
        progress,
      ))
    )
      return true;
    if (code !== "STUDIO_LEASE_LOST") {
      await input.repository.failGeneration(claim, code, {
        ...progress,
        errorCode: code,
        ...(error instanceof StudioContentQualityError ? { reviewIssues: error.checks } : {}),
        ...(error instanceof StudioNoSuitableContentError
          ? { excludedChannels: error.excludedChannels }
          : {}),
        ...(error instanceof StudioClosingPreservationError
          ? {
              presentationIssues: [
                `Closing-card preservation failed for ${error.check}${error.minimum === undefined ? "" : ` (minimum frame similarity ${error.minimum})`}. The existing draft was retained.`,
              ],
            }
          : {}),
      });
    }
    input.onError?.(code);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export async function runStudioLoop(input: StudioWorkerInput): Promise<void> {
  // Independent loops keep a long video render from delaying publication status polling.
  const loop = async (step: () => Promise<boolean>) => {
    while (!input.signal.aborted) {
      try {
        const worked = await step();
        if (worked) continue;
      } catch {
        input.onError?.("STUDIO_QUEUE_UNAVAILABLE");
      }
      try {
        await pause(1500, undefined, { signal: input.signal });
      } catch {
        break;
      }
    }
  };
  await Promise.all([
    ...Array.from({ length: studioCapacity(input.env).generation }, (_, slot) =>
      loop(() => runStudioGenerationOnce({ ...input, workerId: `${input.workerId}-${slot + 1}` })),
    ),
    loop(() => runStudioPublicationOnce(input)),
  ]);
}
