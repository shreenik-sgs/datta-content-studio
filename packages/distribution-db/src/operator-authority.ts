import { createStudioRoleAuthority } from "./studio-authority";
export type DistributionRoleAuthority = (input: {
  userId: string;
  isTest: boolean;
  capability: "content.create" | "content.review";
}) => Promise<boolean>;
export const createDistributionRoleAuthority = createStudioRoleAuthority;
