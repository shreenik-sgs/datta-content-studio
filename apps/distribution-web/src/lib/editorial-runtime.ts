import { createDistributionEditorialRepository } from "@satsang/distribution-db";
import { distributionPool } from "./runtime";

export function editorialRepository() {
  return createDistributionEditorialRepository(distributionPool());
}
