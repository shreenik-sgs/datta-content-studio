/** Package maintenance an administrator performs with operations.manage alone.
 * Its actor is recorded on the revision, never as a content contributor, because
 * posting rechecks every contributor's Content Curator role and an administrator
 * never holds it. */
export const STUDIO_ADMINISTRATIVE_ACTIONS = [
  "CLOSING_REVIEW_REOPENED",
  "CLOSING_DESTINATION_UPDATED",
  "CLOSING_CARDS_REFRESHED",
] as const;
export type StudioContributorRecord = {
  id: string;
  /** Current roles, or null when no operator record exists. */
  roles: readonly string[] | null;
  active: boolean;
  /** Every revision action this operator performed on the package. */
  actions: readonly string[];
};
export type StudioContributorRepair = {
  contributorIds: string[];
  /** Operators recorded by administrative maintenance alone; safe to remove. */
  removed: string[];
  /** Former curators who authored content; kept so posting still refuses them until an Admin acts. */
  revoked: string[];
};
/** Decide which recorded contributors were added by administrative maintenance alone.
 * A current curator stays. Anyone who authored content (the creator, or the actor of
 * any non-administrative revision) also stays even when revoked: the revoked-authority
 * check must keep refusing publication until an Admin reviews that account. */
export function studioRepairContributors(input: {
  createdBy: string;
  contributorIds: readonly string[];
  records: ReadonlyMap<string, StudioContributorRecord>;
}): StudioContributorRepair {
  const removed: string[] = [];
  const revoked: string[] = [];
  const administrative: readonly string[] = STUDIO_ADMINISTRATIVE_ACTIONS;
  const contributorIds = input.contributorIds.filter((id) => {
    const record = input.records.get(id);
    if (record?.active && record.roles?.includes("CONTENT_COORDINATOR")) return true;
    const administrativeOnly =
      id !== input.createdBy &&
      record !== undefined &&
      record.actions.length > 0 &&
      record.actions.every((action) => administrative.includes(action));
    (administrativeOnly ? removed : revoked).push(id);
    return !administrativeOnly;
  });
  return { contributorIds, removed, revoked };
}
