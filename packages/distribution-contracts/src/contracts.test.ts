import { describe, expect, it } from "vitest";
import { distributionEventSchema, distributionHealthSchema } from "./index";

describe("DS-DIST-R0 versioned contracts", () => {
  it("DS-DIST-R0-04 accepts the v1 health shape", () => {
    expect(
      distributionHealthSchema.parse({
        service: "distribution-web",
        version: 1,
        stage: "OFF",
        status: "ok",
      }),
    ).toMatchObject({ stage: "OFF" });
  });

  it("DS-DIST-R0-05 rejects unversioned and future event envelopes", () => {
    expect(() => distributionEventSchema.parse({ type: "content.approved" })).toThrow();
    expect(() =>
      distributionEventSchema.parse({
        version: 2,
        id: crypto.randomUUID(),
        type: "content.approved",
        occurredAt: new Date().toISOString(),
        payload: {},
      }),
    ).toThrow();
  });

  it("DS-DIST-R0-05b accepts only strict, bounded foundation events", () => {
    const valid = {
      version: 1,
      id: crypto.randomUUID(),
      type: "distribution.foundation.checked",
      occurredAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      payload: { buildRevision: "local" },
    };
    expect(distributionEventSchema.parse(valid)).toEqual(valid);
    expect(() =>
      distributionEventSchema.parse({ ...valid, email: "person@example.com" }),
    ).toThrow();
    expect(() =>
      distributionEventSchema.parse({ ...valid, payload: { buildRevision: "x".repeat(129) } }),
    ).toThrow();
  });
});
