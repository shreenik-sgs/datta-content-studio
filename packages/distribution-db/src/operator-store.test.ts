import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  currentStudioAuthority,
  hashOperatorPassword,
  operatorTokenHash,
  readStudioSession,
  verifyOperatorPassword,
} from "./operator-store";
it("salts passwords and rejects incorrect or malformed credentials", async () => {
  const password = "a-test-password-only";
  const a = await hashOperatorPassword(password);
  const b = await hashOperatorPassword(password);
  expect(a).not.toBe(b);
  expect(a).not.toContain(password);
  expect(await verifyOperatorPassword(password, a)).toBe(true);
  expect(await verifyOperatorPassword("wrong-password", a)).toBe(false);
  expect(await verifyOperatorPassword(password, "malformed")).toBe(false);
  await expect(hashOperatorPassword("short")).rejects.toThrow("PASSWORD_LENGTH");
});
it("looks up only a hash of the opaque token in the Hub's own session table", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query } as unknown as Pick<Pool, "query">;
  const token = "b".repeat(64);
  expect(await readStudioSession(token, pool)).toBeNull();
  expect(query.mock.calls[0]?.[1]).toEqual([operatorTokenHash(token)]);
  expect(query.mock.calls[0]?.[0]).toContain("distribution.operator_session");
  expect(query.mock.calls[0]?.[0]).toContain("o.active=true");
});
it("checks fresh independent roles and separates curator from approver", async () => {
  const query = vi.fn();
  const pool = { query } as unknown as Pick<Pool, "query">;
  const input = {
    userId: "11111111-1111-4111-8111-111111111111",
    isTest: true,
    capability: "content.review" as const,
  };
  query
    .mockResolvedValueOnce({ rows: [{ roles: ["CONTENT_COORDINATOR"] }] })
    .mockResolvedValueOnce({ rows: [{ roles: ["CONTENT_APPROVER"] }] })
    .mockResolvedValueOnce({ rows: [] });
  expect(await currentStudioAuthority(input, pool)).toBe(false);
  expect(await currentStudioAuthority(input, pool)).toBe(true);
  expect(await currentStudioAuthority(input, pool)).toBe(false);
  expect(query).toHaveBeenCalledTimes(3);
});
