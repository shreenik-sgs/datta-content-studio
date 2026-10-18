import type { Pool } from "pg";
import { currentStudioAuthority, studioIdentityPool } from "./operator-store";
export type StudioRoleAuthority = (input: {
  userId: string;
  isTest: boolean;
  capability: "content.create" | "content.review" | "content.publish";
}) => Promise<boolean>;
export function createStudioRoleAuthority(
  env: Record<string, string | undefined>,
  pool?: Pick<Pool, "query">,
): StudioRoleAuthority {
  return async (input) => {
    if (
      env.DISTRIBUTION_HUB_ENABLED !== "true" ||
      !["TEST", "LIMITED", "ON"].includes(env.DISTRIBUTION_HUB_STAGE ?? "") ||
      input.isTest !== (env.DISTRIBUTION_HUB_STAGE === "TEST")
    )
      throw new Error("OPERATOR_AUTHORITY_UNAVAILABLE");
    return currentStudioAuthority(input, pool ?? studioIdentityPool(env));
  };
}
