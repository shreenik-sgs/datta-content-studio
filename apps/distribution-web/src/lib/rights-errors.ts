export const rightsFields = {
  owner: { name: "owner", label: "Rights holder" },
  authorizationBasis: { name: "authorization", label: "Authorization" },
  territories: { name: "territories", label: "Territories" },
  channels: { name: "rightsChannel", label: "Allowed publication channels" },
  privacyClass: { name: "privacy", label: "Privacy" },
  releaseAt: { name: "release", label: "Release date" },
  expiresAt: { name: "expiry", label: "Expiry date" },
} as const;
export type RightsField = keyof typeof rightsFields;
export type RightsErrors = Partial<Record<RightsField, string>>;
export function rightsErrors(
  issues: { path: (string | number)[]; message: string }[],
): RightsErrors {
  const result: RightsErrors = {};
  for (const issue of issues) {
    const field = issue.path.find((part) => Object.hasOwn(rightsFields, part)) as
      | RightsField
      | undefined;
    if (field && !result[field]) result[field] = issue.message;
  }
  return result;
}
