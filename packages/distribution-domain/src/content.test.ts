import { describe, expect, it } from "vitest";
import {
  type ContentMaster,
  type ContentRights,
  MAX_MASTER_BYTES,
  MAX_ONLINE_MASTER_BYTES,
  contentApprovalDecision,
  contentExportDecision,
  contentStateAfterEdit,
  hasDistributionCapability,
  requireContentRevision,
  validateContentRights,
  validateMasterUpload,
} from "./index";

const now = "2026-09-29T12:00:00.000Z";
const rights: ContentRights = {
  owner: "SGS",
  territories: ["WORLDWIDE"],
  channels: ["manual_export"],
  authorizationBasis: "Rights holder permission",
  privacyClass: "PUBLIC",
  releaseAt: null,
  expiresAt: null,
};
const content: ContentMaster = {
  id: "master",
  title: "Sacred flute",
  language: "en",
  category: "sacred_flute",
  isTest: true,
  state: "APPROVED",
  revision: 3,
  currentVersion: {
    id: "version",
    masterId: "master",
    number: 1,
    sha256: "a".repeat(64),
    byteSize: 20,
    mimeType: "audio/mpeg",
    originalName: "flute.mp3",
    createdAt: now,
    createdBy: "creator",
  },
  rights,
  approval: { versionId: "version", approvedRevision: 3, reviewerId: "reviewer", approvedAt: now },
  createdAt: now,
  updatedAt: now,
};
const decision = (c: ContentMaster, overrides = {}) =>
  contentExportDecision({
    content: c,
    channel: "manual_export",
    territory: "WORLDWIDE",
    now,
    ...overrides,
  });

describe("DS-DIST-R1 pure authorization and rights", () => {
  it("DS-DIST-R1-AUTH follows assigned content duties and cannot use old grants to bypass them", () => {
    const actor = { id: "operator", roles: ["CONTENT_APPROVER"], isTest: true, locale: "en" };
    expect(hasDistributionCapability(actor, ["content.create"], "content.create")).toBe(false);
    expect(hasDistributionCapability(actor, [], "content.create")).toBe(false);
    expect(hasDistributionCapability(actor, [], "content.review")).toBe(true);
    expect(hasDistributionCapability(actor, [], "content.publish")).toBe(true);
    const coordinator = { ...actor, roles: ["CONTENT_COORDINATOR"] };
    expect(hasDistributionCapability(coordinator, [], "content.create")).toBe(true);
    expect(
      hasDistributionCapability(
        coordinator,
        ["content.review", "content.publish", "campaigns.manage"],
        "content.review",
      ),
    ).toBe(false);
    expect(hasDistributionCapability(coordinator, ["campaigns.manage"], "campaigns.manage")).toBe(
      false,
    );
    expect(
      hasDistributionCapability({ ...actor, roles: ["SUPER_ADMIN"] }, [], "content.create"),
    ).toBe(false);
    for (const role of ["ADMIN_MODERATOR", "SRI_SWAMIJI", "admin", "super_admin", "PRACTITIONER"])
      expect(
        hasDistributionCapability(
          { ...actor, roles: [role] },
          ["content.create"],
          "content.create",
        ),
      ).toBe(false);
  });
  it("DS-DIST-R1-CONTENT refuses stale or invalid optimistic revisions", () => {
    expect(() => requireContentRevision(3, 3)).not.toThrow();
    for (const old of [2, 4, 0, Number.NaN, 3.5])
      expect(() => requireContentRevision(3, old)).toThrow("REVISION_CONFLICT");
  });
  it("DS-DIST-R1-EXPORT permits only the reviewed source and current metadata revision", () => {
    expect(decision(content)).toEqual({ allowed: true });
    expect(decision({ ...content, state: "WITHDRAWN" })).toEqual({
      allowed: false,
      reason: "WITHDRAWN",
    });
    expect(decision({ ...content, state: "DRAFT" })).toEqual({
      allowed: false,
      reason: "NOT_APPROVED",
    });
    expect(decision({ ...content, approval: null })).toEqual({
      allowed: false,
      reason: "APPROVAL_STALE",
    });
    expect(decision({ ...content, revision: 4 })).toEqual({
      allowed: false,
      reason: "APPROVAL_STALE",
    });
    expect(
      decision({ ...content, currentVersion: { ...content.currentVersion, id: "replacement" } }),
    ).toEqual({ allowed: false, reason: "APPROVAL_STALE" });
  });
  it("DS-DIST-R1-EXPORT rechecks release, expiry, channel, territory and privacy every time", () => {
    expect(
      decision({ ...content, rights: { ...rights, releaseAt: "2026-09-30T00:00:00Z" } }),
    ).toMatchObject({ reason: "RELEASE_PENDING" });
    expect(decision({ ...content, rights: { ...rights, expiresAt: now } })).toMatchObject({
      reason: "RIGHTS_EXPIRED",
    });
    expect(decision(content, { channel: "youtube" })).toMatchObject({
      reason: "CHANNEL_NOT_PERMITTED",
    });
    expect(decision({ ...content, rights: { ...rights, territories: ["IN"] } })).toMatchObject({
      reason: "TERRITORY_NOT_PERMITTED",
    });
    expect(
      decision({ ...content, rights: { ...rights, territories: ["IN"] } }, { territory: "IN" }),
    ).toEqual({ allowed: true });
    expect(
      decision({ ...content, rights: { ...rights, privacyClass: "RESTRICTED" } }),
    ).toMatchObject({ reason: "RESTRICTED_CONTENT" });
    expect(
      decision(
        { ...content, rights: { ...rights, privacyClass: "INTERNAL", channels: ["youtube"] } },
        { channel: "youtube" },
      ),
    ).toMatchObject({ reason: "RESTRICTED_CONTENT" });
    expect(decision(content, { now: "invalid" })).toMatchObject({ reason: "INVALID_TIME" });
  });
  it("DS-DIST-R1-CONTENT rejects incomplete or internally inconsistent rights", () => {
    expect(() => validateContentRights(rights)).not.toThrow();
    for (const invalid of [
      { ...rights, owner: " " },
      { ...rights, channels: [] },
      { ...rights, territories: [] },
      { ...rights, authorizationBasis: "" },
      { ...rights, releaseAt: "not-a-date" },
      { ...rights, releaseAt: now, expiresAt: "2026-09-28T00:00:00Z" },
    ])
      expect(() => validateContentRights(invalid)).toThrow("INVALID_RIGHTS");
  });
});

describe("DS-DIST-R1-ASSET master signature and bounds", () => {
  it("accepts long online masters above 2 GB without relaxing the separate upload default", () => {
    const file = {
      byteSize: 3 * 1024 ** 3,
      mimeType: "video/mp4",
      signature: new TextEncoder().encode("0000ftypisom0000"),
    };
    expect(validateMasterUpload(file, MAX_ONLINE_MASTER_BYTES)).toBe("video/mp4");
    expect(() => validateMasterUpload(file)).toThrow("UPLOAD_TOO_LARGE");
    expect(() =>
      validateMasterUpload(
        { ...file, byteSize: MAX_ONLINE_MASTER_BYTES + 1 },
        MAX_ONLINE_MASTER_BYTES,
      ),
    ).toThrow("UPLOAD_TOO_LARGE");
  });
  it("DS-DIST-R1-ASSET checks declared MIME against a bounded source signature", () => {
    expect(
      validateMasterUpload({
        byteSize: 100,
        mimeType: "image/png",
        signature: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      }),
    ).toBe("image/png");
    expect(
      validateMasterUpload({
        byteSize: 100,
        mimeType: "audio/mpeg",
        signature: Uint8Array.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]),
      }),
    ).toBe("audio/mpeg");
    expect(() =>
      validateMasterUpload({
        byteSize: 100,
        mimeType: "image/jpeg",
        signature: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      }),
    ).toThrow("INVALID_MEDIA");
    expect(() =>
      validateMasterUpload({
        byteSize: 100,
        mimeType: "text/html",
        signature: Uint8Array.from([60, 104, 116, 109, 108]),
      }),
    ).toThrow("INVALID_MEDIA");
    expect(() =>
      validateMasterUpload({
        byteSize: MAX_MASTER_BYTES + 1,
        mimeType: "image/png",
        signature: new Uint8Array(),
      }),
    ).toThrow("UPLOAD_TOO_LARGE");
    expect(() =>
      validateMasterUpload({ byteSize: 0, mimeType: "image/png", signature: new Uint8Array() }),
    ).toThrow("INVALID_MEDIA");
  });
});

describe("DS-DIST-R1-CONTENT immutable version review", () => {
  it("DS-DIST-R1-CONTENT invalidates approval after metadata, rights or source changes", () => {
    expect(contentStateAfterEdit("APPROVED", "metadata")).toBe("RIGHTS_CLEARED");
    expect(contentStateAfterEdit("PUBLISHED", "rights")).toBe("RIGHTS_CLEARED");
    expect(contentStateAfterEdit("APPROVED", "version")).toBe("DRAFT");
    expect(contentStateAfterEdit("DRAFT", "metadata")).toBe("DRAFT");
    for (const change of ["metadata", "rights", "version"] as const)
      expect(() => contentStateAfterEdit("WITHDRAWN", change)).toThrow("INVALID_TRANSITION");
  });
  it("DS-DIST-R1-CONTENT permits scheduled approval but refuses expired or missing rights", () => {
    const review = { ...content, state: "RIGHTS_CLEARED" as const, approval: null };
    expect(contentApprovalDecision({ content: review, now })).toEqual({ allowed: true });
    expect(
      contentApprovalDecision({
        content: { ...review, rights: { ...rights, releaseAt: "2026-09-30T00:00:00Z" } },
        now,
      }),
    ).toEqual({ allowed: true });
    expect(
      contentApprovalDecision({
        content: { ...review, rights: { ...rights, expiresAt: now } },
        now,
      }),
    ).toMatchObject({ reason: "RIGHTS_EXPIRED" });
    expect(contentApprovalDecision({ content: { ...review, rights: null }, now })).toMatchObject({
      reason: "RIGHTS_MISSING",
    });
    expect(contentApprovalDecision({ content: { ...review, state: "DRAFT" }, now })).toMatchObject({
      reason: "NOT_READY_FOR_REVIEW",
    });
  });
});
