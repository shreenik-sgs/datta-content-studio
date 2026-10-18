import {
  createDistributionActivationRepository,
  createDistributionOutreachRepository,
  createDistributionRoleAuthority,
} from "@satsang/distribution-db";
import { distributionPool } from "./runtime";
/** Authoring starts with internal destinations only. No operator-supplied origins. */
export function outreachRepository() {
  return createDistributionOutreachRepository(distributionPool());
}

export function activationRepository() {
  // Activation repository already refuses every non-TEST world. Never
  // construct the local authority in any other stage.
  return createDistributionActivationRepository(
    distributionPool(),
    process.env.DISTRIBUTION_HUB_STAGE === "TEST"
      ? { authorize: createDistributionRoleAuthority(process.env) }
      : {},
  );
}
