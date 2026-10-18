import { describe, expect, it } from "vitest";
import { workerPlan } from "./worker";

describe("DS-DIST-R0 worker isolation", () => {
  it("DS-DIST-R0-07 starts no queues or providers while OFF", () => {
    expect(workerPlan(undefined, true)).toEqual({ stage: "OFF", start: false, queues: [] });
    expect(workerPlan("OFF", true)).toEqual({ stage: "OFF", start: false, queues: [] });
    expect(workerPlan("ON", false)).toEqual({ stage: "ON", start: false, queues: [] });
    expect(workerPlan("TEST", true)).toEqual({
      stage: "TEST",
      start: true,
      queues: ["distribution:content.ingest", "distribution:release.dispatch"],
    });
  });
});
