import { type DistributionStage, normalizeDistributionStage } from "@satsang/distribution-domain";

export type WorkerPlan = { stage: DistributionStage; start: boolean; queues: string[] };

export function workerPlan(value: string | undefined, featureEnabled: boolean): WorkerPlan {
  const stage = normalizeDistributionStage(value);
  if (!featureEnabled || stage === "OFF") return { stage, start: false, queues: [] };
  return {
    stage,
    start: true,
    queues: ["distribution:content.ingest", "distribution:release.dispatch"],
  };
}
