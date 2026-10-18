import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDistributionRepository, distributionTransactionRolledBack } from "./repository.js";

const context = { userId: "creator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
const input = {
  title: "Test upload",
  language: "en",
  category: "sacred_flute",
  asset: {
    storageKey: "distribution/masters/019434f0-0ce2-4859-bdb5-d40d44387099",
    sha256: "a".repeat(64),
    byteSize: 3,
    mimeType: "audio/mpeg",
    originalName: "test.mp3",
  },
};
function fixture(options: { operationError?: Error; commitError?: Error; rollbackError?: Error }) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "COMMIT" && options.commitError) throw options.commitError;
    if (sql === "ROLLBACK" && options.rollbackError) throw options.rollbackError;
    if (sql.includes("INSERT INTO distribution.content_version") && options.operationError)
      throw options.operationError;
    if (sql.startsWith("SELECT m.*"))
      return {
        rows: [
          {
            id: "master",
            is_test: true,
            title: input.title,
            language: input.language,
            category: input.category,
            state: "DRAFT",
            revision: 1,
            version_id: "version",
            version_number: 1,
            sha256: input.asset.sha256,
            byte_size: 3,
            mime_type: input.asset.mimeType,
            original_name: input.asset.originalName,
            version_created_by: context.userId,
            version_created_at: "2026-10-05T00:00:00Z",
            created_at: "2026-10-05T00:00:00Z",
            updated_at: "2026-10-05T00:00:00Z",
            rights: null,
            approval: null,
          },
        ],
      };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  return { repository: createDistributionRepository(pool), query, release };
}
async function capture(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("Expected a rejected transaction");
  } catch (error) {
    return error;
  }
}

describe("DS-DIST-S3 upload rollback proof", () => {
  it("allows orphan cleanup only when a pre-commit write failure rolls back successfully", async () => {
    const problem = new Error("REVISION_CONFLICT");
    const fixtureResult = fixture({ operationError: problem });
    const error = await capture(fixtureResult.repository.create(context, input));
    expect(error).toMatchObject({ message: "REVISION_CONFLICT", cause: problem });
    expect(distributionTransactionRolledBack(error)).toBe(true);
    expect(distributionTransactionRolledBack(problem)).toBe(false);
    expect(fixtureResult.query).not.toHaveBeenCalledWith("COMMIT");
    expect(fixtureResult.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixtureResult.release).toHaveBeenCalledOnce();
  });
  it("retains bytes after a lost COMMIT acknowledgement even if a later ROLLBACK returns", async () => {
    const problem = new Error("COMMIT connection lost");
    const fixtureResult = fixture({ commitError: problem });
    const error = await capture(fixtureResult.repository.create(context, input));
    expect(error).toBe(problem);
    expect(distributionTransactionRolledBack(error)).toBe(false);
    expect(fixtureResult.query).toHaveBeenCalledWith("COMMIT");
    expect(fixtureResult.query).toHaveBeenCalledWith("ROLLBACK");
    expect(fixtureResult.release).toHaveBeenCalledOnce();
  });
  it("retains bytes if ROLLBACK cannot be confirmed and preserves the original error", async () => {
    const problem = new Error("FORBIDDEN");
    const fixtureResult = fixture({
      operationError: problem,
      rollbackError: new Error("ROLLBACK connection lost"),
    });
    const error = await capture(fixtureResult.repository.create(context, input));
    expect(error).toBe(problem);
    expect(distributionTransactionRolledBack(error)).toBe(false);
    expect(fixtureResult.release).toHaveBeenCalledOnce();
  });
  it("does not infer successful rollback from an error name, code, or user-controlled object", () => {
    for (const error of [new Error("FORBIDDEN"), { message: "REVISION_CONFLICT" }, null])
      expect(distributionTransactionRolledBack(error)).toBe(false);
  });
});
