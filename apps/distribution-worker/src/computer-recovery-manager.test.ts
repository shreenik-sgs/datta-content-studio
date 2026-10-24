import { expect, it, vi } from "vitest";
import { createComputerRecoveryManager } from "./computer-recovery-manager";
const env = {
  STUDIO_IDENTITY: "gbadpt",
  DISTRIBUTION_HUB_STAGE: "TEST",
  DISTRIBUTION_HUB_ENABLED: "true",
  STUDIO_COMPUTER_RECOVERY_ENABLED: "true",
  DISTRIBUTION_APP_ORIGIN: "http://localhost:3070",
  STUDIO_COMPUTER_RECOVERY_DIRECTORY: "/private/tmp/studio-test",
};
const context = { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
const start = () => ({ action: "start" as const, username: "Curator", password: "secret" });
it("serializes recovery, hides another operator's job and safely stops before resuming", async () => {
  const run = vi.fn(
    async (input) =>
      new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", resolve, { once: true }),
      ),
  );
  const manager = createComputerRecoveryManager({
    env,
    signal: new AbortController().signal,
    authorize: vi.fn().mockResolvedValue(true),
    preflight: vi.fn().mockResolvedValue(undefined),
    run,
  });
  expect((await manager.handle(context, "bundle", start())).status).toBe("RUNNING");
  await manager.handle(context, "bundle", start());
  expect(run).toHaveBeenCalledOnce();
  await expect(
    manager.handle({ ...context, userId: "other" }, "bundle", { action: "status" }),
  ).rejects.toThrow("RECOVERY_BUSY");
  expect((await manager.handle(context, "bundle", { action: "stop" })).status).toBe("STOPPING");
  await manager.close();
  // A cancelled runner may finish its final reconciliation normally; it must not claim completion.
  expect((await manager.handle(context, "bundle", { action: "status" })).status).toBe("PAUSED");
});
it("rejects cloud execution and revoked Curator roles", async () => {
  const authorize = vi.fn().mockResolvedValue(false);
  const manager = createComputerRecoveryManager({
    env,
    signal: new AbortController().signal,
    authorize,
  });
  await expect(manager.handle(context, "bundle", start())).rejects.toThrow("RECOVERY_FORBIDDEN");
  const cloud = createComputerRecoveryManager({
    env: { ...env, DISTRIBUTION_APP_ORIGIN: "https://gbadpt.sgsdattasannidhi.org" },
    signal: new AbortController().signal,
    authorize,
  });
  await expect(cloud.handle(context, "bundle", start())).rejects.toThrow("RECOVERY_LOCAL_REQUIRED");
});
it("reports sanitized failures and removes the password from the pending command", async () => {
  const command = start();
  const manager = createComputerRecoveryManager({
    env,
    signal: new AbortController().signal,
    authorize: vi.fn().mockResolvedValue(true),
    preflight: vi.fn().mockRejectedValue(Error("private internal exception")),
  });
  await manager.handle(context, "bundle", command);
  await manager.close();
  const state = await manager.handle(context, "bundle", { action: "status" });
  expect(state.error).not.toContain("private internal");
  expect(command.password).toBe("");
});
