import { createDistributionAnalyticsRepository } from "@satsang/distribution-db";
import { distributionPool } from "./runtime";
export function analyticsRepository() {
  return createDistributionAnalyticsRepository(distributionPool());
}
