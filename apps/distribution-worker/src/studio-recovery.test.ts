import { STUDIO_MEDIA_PIPELINE_VERSION } from "@satsang/distribution-domain";
import { beforeEach, expect, it, vi } from "vitest";
import { runStudioRecoveryOnce, studioRecoveryScheduler } from "./studio-recovery";

const repository = { recoverFailedGenerations: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
});

it("asks the repository to retry failures recorded under an older pipeline and reports each one", async () => {
  repository.recoverFailedGenerations.mockResolvedValue([
    { packageId: "p1", failure: "STUDIO_PRESENTATION_REPAIR_REQUIRED", outcome: "requeued" },
    {
      packageId: "p2",
      failure: "RENDER_TIMEOUT",
      outcome: "declined",
      code: "REQUESTER_ROLE_REVOKED",
    },
  ]);
  const onRecovered = vi.fn();
  expect(
    await runStudioRecoveryOnce({
      repository,
      isTest: true,
      env: { STUDIO_RELEASE: "r1" },
      onRecovered,
    }),
  ).toBe(true);
  expect(repository.recoverFailedGenerations).toHaveBeenCalledWith({
    isTest: true,
    mediaPipeline: `${STUDIO_MEDIA_PIPELINE_VERSION}@r1`,
  });
  expect(onRecovered).toHaveBeenCalledTimes(2);
  expect(onRecovered).toHaveBeenCalledWith(
    expect.objectContaining({
      packageId: "p2",
      outcome: "declined",
      code: "REQUESTER_ROLE_REVOKED",
      mediaPipeline: `${STUDIO_MEDIA_PIPELINE_VERSION}@r1`,
    }),
  );
});

it("contains a repository outage as a safe code and keeps the worker loop alive", async () => {
  repository.recoverFailedGenerations.mockRejectedValue(new Error("connection string with secret"));
  const onError = vi.fn();
  expect(await runStudioRecoveryOnce({ repository, isTest: false, env: {}, onError })).toBe(false);
  expect(onError).toHaveBeenCalledWith("STUDIO_RECOVERY_UNAVAILABLE");
});

it("runs immediately at start-up and then at most once per interval", async () => {
  repository.recoverFailedGenerations.mockResolvedValue([]);
  const step = studioRecoveryScheduler({ repository, isTest: true, env: {} }, 60000);
  await step(1000);
  await step(30000);
  await step(60999);
  expect(repository.recoverFailedGenerations).toHaveBeenCalledTimes(1);
  await step(61000);
  expect(repository.recoverFailedGenerations).toHaveBeenCalledTimes(2);
});
