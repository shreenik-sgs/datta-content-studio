import type { createIntelligentContentRepository } from "@satsang/distribution-db";
import { studioMediaPipeline } from "@satsang/distribution-domain";

export type StudioRecoveryInput = {
  repository: Pick<
    ReturnType<typeof createIntelligentContentRepository>,
    "recoverFailedGenerations"
  >;
  isTest: boolean;
  env: Record<string, string | undefined>;
  onRecovered?: (result: {
    packageId: string;
    failure: string;
    outcome: "requeued" | "declined";
    code?: string;
    mediaPipeline: string;
  }) => void;
  onError?: (code: string) => void;
};

/** Retry recordings that this worker's own rendering or final media gate failed under an
 * older pipeline. Each failed job gets one automatic retry per pipeline, through the same
 * checked request path a curator uses, so a paused series, a changed source or a revoked
 * curator role still refuses it. Returns whether any recording was requeued. */
export async function runStudioRecoveryOnce(input: StudioRecoveryInput): Promise<boolean> {
  const mediaPipeline = studioMediaPipeline(input.env);
  try {
    const results = await input.repository.recoverFailedGenerations({
      isTest: input.isTest,
      mediaPipeline,
    });
    for (const result of results) input.onRecovered?.({ ...result, mediaPipeline });
    return results.some((result) => result.outcome === "requeued");
  } catch {
    input.onError?.("STUDIO_RECOVERY_UNAVAILABLE");
    return false;
  }
}

/** Runs at start-up and then at most once per interval inside an existing polling loop. */
export function studioRecoveryScheduler(input: StudioRecoveryInput, intervalMs = 60000) {
  let next = 0;
  return async (now = Date.now()): Promise<boolean> => {
    if (now < next) return false;
    next = now + intervalMs;
    return runStudioRecoveryOnce(input);
  };
}
