import { type DistributionStage, normalizeDistributionStage } from "@satsang/distribution-domain";

export function distributionStage(value: string | undefined): DistributionStage {
  return normalizeDistributionStage(value);
}

export function distributionFeatureEnabled(value: string | undefined): boolean {
  return value === "true";
}
