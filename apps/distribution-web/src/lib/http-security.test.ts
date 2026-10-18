import { describe, expect, it } from "vitest";
import { safeProblem } from "./http";
describe("DS-DIST-R1 HTTP error disclosure", () => {
  it("DS-DIST-R1-EXPORT maps only recognized lifecycle refusal reasons", async () => {
    for (const [reason, status] of [
      ["EXPORT_REFUSED:RIGHTS_EXPIRED", 409],
      ["APPROVAL_REFUSED:RIGHTS_MISSING", 409],
      ["EXPORT_REFUSED:FORBIDDEN", 403],
    ] as const) {
      const response = safeProblem(Error(reason));
      expect(response.status).toBe(status);
    }
    expect(await safeProblem(Error("EXPORT_REFUSED:password=secret")).json()).toEqual({
      error: "unavailable",
    });
  });
  it("DS-DIST-R1-AUTH only maps own error codes, never inherited prototype keys", async () => {
    for (const code of ["toString", "constructor", "__proto__", "valueOf"]) {
      const response = safeProblem(new Error(code));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
    }
  });
});
