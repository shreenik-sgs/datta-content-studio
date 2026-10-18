import { describe, expect, it } from "vitest";
import {
  approvalCommandSchema,
  contentListQuerySchema,
  contentRightsSchema,
  createContentSchema,
  distributionOperatorSchema,
  exportCommandSchema,
} from "./index";
const rights = {
  owner: "SGS",
  territories: ["WORLDWIDE"],
  channels: ["manual_export"],
  authorizationBasis: "Written permission",
  privacyClass: "PUBLIC",
  releaseAt: null,
  expiresAt: null,
};
describe("DS-DIST-R1 shared strict commands", () => {
  it("allows explicit active and withdrawn views while retaining legacy list visibility", () => {
    expect(contentListQuerySchema.parse({}).archive).toBe("all");
    for (const archive of ["active", "withdrawn", "all"])
      expect(contentListQuerySchema.parse({ archive, offset: "50" })).toMatchObject({
        archive,
        offset: 50,
      });
    expect(() => contentListQuerySchema.parse({ archive: "deleted" })).toThrow();
  });
  it("DS-DIST-R1-CONTENT accepts controlled metadata and rejects mass assignment", () => {
    const valid = { title: "Sacred flute", language: "te", category: "sacred_flute" };
    expect(createContentSchema.parse(valid)).toEqual(valid);
    expect(createContentSchema.parse({ ...valid, language: "sa" }).language).toBe("sa");
    expect(() => createContentSchema.parse({ ...valid, state: "APPROVED" })).toThrow();
    expect(() => createContentSchema.parse({ ...valid, isTest: false })).toThrow();
    expect(() => createContentSchema.parse({ ...valid, title: " " })).toThrow();
  });
  it("DS-DIST-R1-CONTENT validates rights dates and bounded channel/territory assignments", () => {
    expect(contentRightsSchema.parse(rights)).toEqual(rights);
    expect(() => contentRightsSchema.parse({ ...rights, channels: [] })).toThrow();
    expect(() =>
      contentRightsSchema.parse({
        ...rights,
        releaseAt: "2026-09-30T00:00:00Z",
        expiresAt: "2026-09-29T00:00:00Z",
      }),
    ).toThrow();
    expect(() => contentRightsSchema.parse({ ...rights, territories: ["*"] })).toThrow();
  });
  it("DS-DIST-R1-AUTH never accepts capabilities inside an identity assertion", () => {
    const actor = { id: "operator", roles: ["TECH_SUPER_ADMIN"], isTest: true, locale: "en" };
    expect(distributionOperatorSchema.parse(actor)).toEqual(actor);
    expect(() =>
      distributionOperatorSchema.parse({ ...actor, capabilities: ["content.publish"] }),
    ).toThrow();
  });
  it("DS-DIST-R1-EXPORT requires positive revision and bounded approved targets", () => {
    expect(approvalCommandSchema.parse({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
    expect(() => approvalCommandSchema.parse({ expectedRevision: 0 })).toThrow();
    expect(
      exportCommandSchema.parse({
        expectedRevision: 2,
        channel: "manual_export",
        territory: "WORLDWIDE",
      }),
    ).toMatchObject({ channel: "manual_export" });
    expect(() =>
      exportCommandSchema.parse({
        expectedRevision: 2,
        channel: "unknown",
        territory: "WORLDWIDE",
      }),
    ).toThrow();
  });
});
