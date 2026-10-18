import { describe, expect, it } from "vitest";
import type { StudioPackage, StudioPublication } from "./intelligent-content";
import { studioWorkflow } from "./studio-progress";
const pkg = (status: StudioPackage["status"], returned = false) => ({
  status,
  revision: 3,
  isTest: false,
  feedback: returned
    ? [
        {
          id: "feedback",
          actorId: "approver",
          action: "REJECTED" as const,
          comment: "Correct caption",
          revision: 2,
          createdAt: "2026-10-11T01:00:00Z",
        },
      ]
    : [],
  outputs: [
    { id: "one", included: true },
    { id: "two", included: true },
    { id: "excluded", included: false },
  ],
});
const receipt = (outputId: string, status: StudioPublication["status"], packageRevision = 3) => ({
  outputId,
  status,
  packageRevision,
});
describe("guided Studio workflow", () => {
  it("does not imply a review happened when generation or submission changes an internal revision", () => {
    for (const [status, current] of [
      ["QUEUED", 2],
      ["GENERATING", 2],
      ["DRAFT", 3],
      ["IN_REVIEW", 4],
      ["APPROVED", 6],
    ] as const) {
      const flow = studioWorkflow({ package: pkg(status) });
      expect(flow.current).toBe(current);
      expect(flow.steps.find((s) => s.number === 4)?.state).toBe(
        status === "APPROVED" ? "done" : status === "IN_REVIEW" ? "current" : "pending",
      );
      expect(flow.steps.find((s) => s.number === 5)?.label).toBe("Only if needed");
    }
  });
  it("keeps combined-role users in one staged workflow without a fictional handoff", () => {
    expect(studioWorkflow({ package: pkg("DRAFT"), combinedRoles: true }).message).toContain(
      "your separate approval review",
    );
    expect(
      studioWorkflow({ package: pkg("IN_REVIEW"), combinedRoles: true }).message,
    ).not.toContain("Waiting");
    for (const [status, step] of [
      ["DRAFT", 3],
      ["IN_REVIEW", 4],
      ["CHANGES_REQUESTED", 5],
      ["APPROVED", 6],
    ] as const) {
      const flow = studioWorkflow({ package: pkg(status), combinedRoles: true });
      expect(flow.current).toBe(step);
      expect(flow.steps.filter((s) => s.state === "current")).toHaveLength(1);
    }
  });
  it("shows the optional correction loop and requires review again after resubmission", () => {
    expect(studioWorkflow({ package: pkg("CHANGES_REQUESTED", true) }).current).toBe(5);
    expect(studioWorkflow({ package: pkg("DRAFT", true) }).current).toBe(5);
    for (const status of ["QUEUED", "GENERATING", "FAILED"] as const) {
      const correction = studioWorkflow({ package: pkg(status, true) });
      expect(correction.current).toBe(5);
      expect(correction.steps[1]?.state).toBe("done");
    }
    const submitted = studioWorkflow({ package: pkg("IN_REVIEW", true) });
    expect(submitted.current).toBe(4);
    expect(submitted.complete).toBe(false);
  });
  it("requires a receipt for every included current output and never calls a simulation a live post", () => {
    const approved = pkg("APPROVED");
    expect(
      studioWorkflow({
        package: approved,
        publications: [receipt("one", "PUBLISHED"), receipt("two", "PUBLISHED", 2)],
      }).complete,
    ).toBe(false);
    expect(
      studioWorkflow({
        package: approved,
        publications: [receipt("one", "PUBLISHED"), receipt("two", "FAILED")],
      }).message,
    ).toContain("need attention");
    const simulated = [receipt("one", "SIMULATED"), receipt("two", "SIMULATED")];
    expect(studioWorkflow({ package: approved, publications: simulated }).complete).toBe(false);
    const test = studioWorkflow({
      package: { ...approved, isTest: true },
      publications: simulated,
    });
    expect(test.complete).toBe(true);
    expect(test.message).toContain("Nothing was posted");
    expect(
      studioWorkflow({
        package: approved,
        publications: [receipt("one", "PUBLISHED"), receipt("two", "PUBLISHED")],
      }).complete,
    ).toBe(true);
  });
  it("shows stopped packages, failed generation and an unstarted workflow honestly", () => {
    const stopped = studioWorkflow({ package: pkg("DISCARDED") });
    expect(stopped.current).toBeNull();
    expect(stopped.steps.every((s) => s.state === "stopped")).toBe(true);
    expect(studioWorkflow({ package: pkg("FAILED") }).message).toContain("needs attention");
    expect(studioWorkflow({}).current).toBeNull();
    const starting = studioWorkflow({ starting: true });
    expect(starting.current).toBe(1);
    expect(starting.steps[0]?.state).toBe("current");
    expect(
      starting.steps.slice(1).every((s) => s.state === "pending" || s.state === "optional"),
    ).toBe(true);
    expect(starting.message).toContain("Import a video or playlist");
    expect(studioWorkflow({ hasMaster: true }).current).toBe(2);
    expect(studioWorkflow({ hasMaster: true, permissionsReady: false }).current).toBe(1);
  });
});
