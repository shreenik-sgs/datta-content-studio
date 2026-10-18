import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  requireIndependentEditorialReview,
  requireIndependentPackageReview,
  requireIndependentSourceReview,
} from "./review-integrity";

const client = (rows: unknown[]) => ({
  query: vi.fn(async (_sql: string, _parameters: unknown[]) => ({ rows })),
});
describe("immutable review provenance", () => {
  it("source review rejects upload/metadata/rights contributors, not just the original uploader", async () => {
    const c = client([{ actor_id: "uploader" }, { actor_id: "rights-author" }]);
    const input = {
      isTest: true,
      masterId: "master",
      versionId: "version",
      reviewerId: "rights-author",
    };
    await expect(requireIndependentSourceReview(c as unknown as PoolClient, input)).rejects.toThrow(
      "INDEPENDENT_REVIEW_REQUIRED",
    );
    await expect(
      requireIndependentSourceReview(c as unknown as PoolClient, { ...input, reviewerId: "admin" }),
    ).resolves.toBeUndefined();
    expect(c.query.mock.calls[0]).toEqual([
      expect.stringContaining("'CONTENT_CREATED','METADATA_UPDATED'"),
      ["version", "master", true],
    ]);
    expect(c.query.mock.calls[0]?.[0]).not.toContain("VERSION_ADDED");
    expect(c.query.mock.calls[0]?.[0]).toContain("SELECT attested_by AS actor_id");
  });
  it("editorial and native content uses stored creators and refuses missing immutable provenance", async () => {
    for (const kind of ["transcript", "quote", "native"] as const) {
      const c = client([{ created_by: "creator" }]);
      await expect(
        requireIndependentEditorialReview(c as unknown as PoolClient, {
          isTest: false,
          kind,
          id: "revision",
          reviewerId: "creator",
        }),
      ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
      expect(c.query.mock.calls[0]?.[1]).toEqual(["revision", false]);
      await expect(
        requireIndependentEditorialReview(client([]) as unknown as PoolClient, {
          isTest: true,
          kind,
          id: "missing",
          reviewerId: "admin",
        }),
      ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    }
  });
  it("package review covers inherited authors through the reviewed revision and excludes destination testers", async () => {
    for (const kind of ["campaign", "cta", "activation"] as const) {
      const c = client([{ actor_id: "author" }, { actor_id: "copy-editor" }]);
      await expect(
        requireIndependentPackageReview(c as unknown as PoolClient, {
          isTest: true,
          kind,
          id: "package",
          revision: 5,
          reviewerId: "copy-editor",
        }),
      ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
      await expect(
        requireIndependentPackageReview(c as unknown as PoolClient, {
          isTest: true,
          kind,
          id: "package",
          revision: 5,
          reviewerId: "destination-tester",
        }),
      ).resolves.toBeUndefined();
      expect(c.query.mock.calls[0]).toEqual([
        expect.stringContaining("revision<=$3 AND action IN ('CREATED','EDITED')"),
        ["package", true, 5],
      ]);
    }
  });
});
