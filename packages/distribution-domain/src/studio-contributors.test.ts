import { describe, expect, it } from "vitest";
import { type StudioContributorRecord, studioRepairContributors } from "./studio-contributors";
const record = (
  id: string,
  roles: string[] | null,
  actions: string[],
  active = true,
): [string, StudioContributorRecord] => [id, { id, roles, active, actions }];
describe("contributor repair after administrative maintenance", () => {
  it("removes only administrators recorded by maintenance actions alone", () => {
    const result = studioRepairContributors({
      createdBy: "curator",
      contributorIds: ["curator", "admin", "second"],
      records: new Map([
        record("curator", ["CONTENT_COORDINATOR"], ["CREATED", "REVISED"]),
        record(
          "admin",
          ["SUPER_ADMIN"],
          ["CLOSING_REVIEW_REOPENED", "CLOSING_DESTINATION_UPDATED"],
        ),
        record("second", ["CONTENT_COORDINATOR", "CONTENT_APPROVER"], ["GENERATION_REQUESTED"]),
      ]),
    });
    expect(result).toEqual({
      contributorIds: ["curator", "second"],
      removed: ["admin"],
      revoked: [],
    });
  });
  it("keeps and reports former curators who authored content, the creator, and unknown accounts", () => {
    const result = studioRepairContributors({
      createdBy: "creator",
      contributorIds: ["creator", "former", "missing", "silent"],
      records: new Map([
        record("creator", ["SUPER_ADMIN"], ["CREATED", "CLOSING_DESTINATION_UPDATED"]),
        record("former", ["CONTENT_APPROVER"], ["REVISED", "CLOSING_DESTINATION_UPDATED"]),
        record("silent", ["SUPER_ADMIN"], []),
      ]),
    });
    expect(result.contributorIds).toEqual(["creator", "former", "missing", "silent"]);
    expect(result.removed).toEqual([]);
    expect(result.revoked).toEqual(["creator", "former", "missing", "silent"]);
  });
  it("treats a deactivated curator as revoked rather than current", () => {
    const result = studioRepairContributors({
      createdBy: "a",
      contributorIds: ["a", "b"],
      records: new Map([
        record("a", ["CONTENT_COORDINATOR"], ["CREATED"]),
        record("b", ["CONTENT_COORDINATOR"], ["REVISED"], false),
      ]),
    });
    expect(result.revoked).toEqual(["b"]);
    expect(result.contributorIds).toEqual(["a", "b"]);
  });
});
