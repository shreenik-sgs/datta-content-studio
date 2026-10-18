import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderClaim, RenderOutput } from "@satsang/distribution-db";
import { describe, expect, it, vi } from "vitest";
import { localWorkerConfig, runRenderJob, runRenderLoop } from "./run-render-job";

const claim = {
  id: "job-one",
  masterId: "44444444-4444-4444-8444-444444444444",
  isTest: true,
  source: { mimeType: "video/mp4" },
  recipe: {},
  leaseToken: "opaque",
} as RenderClaim;
const output = { recipeSha256: "a".repeat(64) } as RenderOutput;
function ports() {
  return {
    repository: {
      claim: vi.fn().mockResolvedValue(claim),
      succeed: vi.fn().mockResolvedValue({ accepted: true, artifact: { id: "artifact" } }),
      fail: vi.fn().mockResolvedValue({}),
    },
    renderer: {
      render: vi.fn().mockResolvedValue(output),
      discard: vi.fn().mockResolvedValue(undefined),
    },
    workerId: "local-renderer",
    signal: new AbortController().signal,
  };
}
describe("DS-DIST-R3 worker integration boundary", () => {
  it("DS-DIST-R3-OFF requires no configuration while off and refuses remote or non-test workers", () => {
    expect(localWorkerConfig({})).toBeNull();
    expect(
      localWorkerConfig({ DISTRIBUTION_HUB_ENABLED: "false", DISTRIBUTION_HUB_STAGE: "ON" }),
    ).toBeNull();
    expect(() =>
      localWorkerConfig({ DISTRIBUTION_HUB_ENABLED: "true", DISTRIBUTION_HUB_STAGE: "ON" }),
    ).toThrow("LOCAL_TEST_WORKER_ONLY");
    const env = {
      DISTRIBUTION_HUB_ENABLED: "true",
      DISTRIBUTION_HUB_STAGE: "TEST",
      DISTRIBUTION_DATABASE_URL: "postgres://runtime:local@localhost:5442/distribution_local",
      DISTRIBUTION_ASSET_ROOT: join(realpathSync(tmpdir()), "distribution-worker-assets"),
      DISTRIBUTION_FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg",
      DISTRIBUTION_FFPROBE_PATH: "/opt/homebrew/bin/ffprobe",
    };
    expect(localWorkerConfig(env)?.assetRoot).toBe(env.DISTRIBUTION_ASSET_ROOT);
    for (const url of [
      "postgres://runtime@remote.invalid:5442/distribution_local",
      "postgres://runtime@localhost:5432/distribution_local",
      "postgres://runtime@localhost:5442/satsang",
      "postgres://runtime@localhost:5442/distribution_local?host=remote.invalid",
    ])
      expect(() => localWorkerConfig({ ...env, DISTRIBUTION_DATABASE_URL: url })).toThrow(
        "LOCAL_DISTRIBUTION_DATABASE_REQUIRED",
      );
  });
  it("DS-DIST-R3-WORKER renders one claimed job and never discards accepted output", async () => {
    const p = ports();
    expect(await runRenderJob(p)).toEqual({ status: "rendered", jobId: "job-one" });
    expect(p.repository.claim).toHaveBeenCalledWith({
      isTest: true,
      workerId: "local-renderer",
      leaseMs: 240000,
    });
    expect(p.renderer.render).toHaveBeenCalledWith({
      source: { ...claim.source, masterId: claim.masterId },
      recipe: claim.recipe,
      signal: p.signal,
    });
    expect(p.repository.succeed).toHaveBeenCalledWith(claim, output);
    expect(p.renderer.discard).not.toHaveBeenCalled();
  });
  it("S3 storage remains opt-in, requires private scratch, and cannot bypass TEST authority", () => {
    const env = {
      DISTRIBUTION_HUB_ENABLED: "true",
      DISTRIBUTION_HUB_STAGE: "TEST",
      DISTRIBUTION_DATABASE_URL: "postgres://runtime:local@localhost:5442/distribution_local",
      DISTRIBUTION_ASSET_BACKEND: "s3",
      DISTRIBUTION_S3_BUCKET: "synthetic-storage-test",
      DISTRIBUTION_S3_REGION: "us-east-1",
      DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: "123456789012",
      DISTRIBUTION_S3_PREFIX: "test/",
      DISTRIBUTION_RENDER_SCRATCH_ROOT: join(realpathSync(tmpdir()), "distribution-render-scratch"),
      DISTRIBUTION_FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg",
      DISTRIBUTION_FFPROBE_PATH: "/opt/homebrew/bin/ffprobe",
    };
    expect(localWorkerConfig(env)).toMatchObject({
      assetBackend: "s3",
      assetRoot: env.DISTRIBUTION_RENDER_SCRATCH_ROOT,
    });
    expect(() =>
      localWorkerConfig({ ...env, DISTRIBUTION_RENDER_SCRATCH_ROOT: undefined }),
    ).toThrow("LOCAL_RENDER_PATHS_REQUIRED");
    expect(() =>
      localWorkerConfig({ ...env, DISTRIBUTION_RENDER_SCRATCH_ROOT: "relative" }),
    ).toThrow("LOCAL_RENDER_PATHS_REQUIRED");
    expect(() => localWorkerConfig({ ...env, DISTRIBUTION_S3_PREFIX: "production/" })).toThrow(
      "INVALID_S3_ASSET_WORLD",
    );
    expect(() => localWorkerConfig({ ...env, DISTRIBUTION_HUB_STAGE: "ON" })).toThrow(
      "LOCAL_TEST_WORKER_ONLY",
    );
    expect(
      localWorkerConfig({ ...env, DISTRIBUTION_HUB_ENABLED: "false", DISTRIBUTION_S3_BUCKET: "" }),
    ).toBeNull();
  });
  it("DS-DIST-R3-STALE discards only definitively rejected output and retains uncertain commits", async () => {
    const p = ports();
    p.repository.succeed.mockResolvedValue({ accepted: false, reason: "WITHDRAWN" });
    expect(await runRenderJob(p)).toEqual({
      status: "stale",
      jobId: "job-one",
      reason: "WITHDRAWN",
    });
    expect(p.renderer.discard).toHaveBeenCalledExactlyOnceWith(output);
    const uncertain = ports();
    uncertain.repository.succeed.mockRejectedValue(
      new Error("connection lost, credential-containing text"),
    );
    expect(await runRenderJob(uncertain)).toEqual({
      status: "uncertain",
      jobId: "job-one",
      reason: "RESULT_COMMIT_UNCONFIRMED",
    });
    expect(uncertain.renderer.discard).not.toHaveBeenCalled();
    expect(uncertain.repository.fail).not.toHaveBeenCalled();
  });
  it("DS-DIST-R3-RETRY stores only sanitized failures and never claims after cancellation", async () => {
    const p = ports();
    p.renderer.render.mockRejectedValue(new Error("credentials and source details"));
    expect(await runRenderJob(p)).toEqual({
      status: "failed",
      jobId: "job-one",
      reason: "RENDER_FAILED",
    });
    expect(p.repository.fail).toHaveBeenCalledWith(claim, "RENDER_FAILED");
    const cancelled = ports();
    cancelled.signal = AbortSignal.abort();
    expect(await runRenderJob(cancelled)).toEqual({ status: "idle" });
    expect(cancelled.repository.claim).not.toHaveBeenCalled();
  });
  it("DS-DIST-R3-SERIAL runs one render at a time and exits promptly on stop", async () => {
    const p = ports();
    const controller = new AbortController();
    p.signal = controller.signal;
    let active = 0;
    let maximum = 0;
    let calls = 0;
    p.renderer.render.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      calls++;
      return output;
    });
    await runRenderLoop({
      ...p,
      pollMs: 1,
      onResult: () => {
        if (calls === 2) controller.abort();
      },
    });
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
  });
});
