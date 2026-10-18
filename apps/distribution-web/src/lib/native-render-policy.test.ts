import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ governed: vi.fn(), policy: vi.fn() }));
vi.mock("@satsang/distribution-db", () => ({
  createNativeIntelligenceRepository: () => ({ governed: m.governed }),
}));
vi.mock("./runtime", () => ({ distributionPool: () => ({}) }));
vi.mock("./native-policy", async (original) => ({
  ...(await original<typeof import("./native-policy")>()),
  nativePolicy: m.policy,
}));
import { requireNativeRenderPolicy } from "./native-render-policy";
const request = new Request("http://localhost/distribution");
const ctx = { userId: "local", isTest: true };
describe("native flag boundary at derivative actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.governed.mockResolvedValue(true);
    m.policy.mockResolvedValue({
      native_language_intelligence: true,
      teaching_integrity_engine: true,
      native_language_review: true,
      native_clip_candidates: true,
    });
  });
  it("preserves existing non-native behavior without requiring the new flags", async () => {
    m.governed.mockResolvedValue(false);
    await expect(
      requireNativeRenderPolicy(request, ctx, { masterId: "m" }),
    ).resolves.toBeUndefined();
    expect(m.policy).not.toHaveBeenCalled();
  });
  it("requires every gate and fails closed when the policy bridge is unavailable", async () => {
    await expect(
      requireNativeRenderPolicy(request, ctx, { artifactId: "a" }),
    ).resolves.toBeUndefined();
    for (const key of [
      "native_language_intelligence",
      "teaching_integrity_engine",
      "native_language_review",
      "native_clip_candidates",
    ]) {
      m.policy.mockResolvedValue({
        native_language_intelligence: true,
        teaching_integrity_engine: true,
        native_language_review: true,
        native_clip_candidates: true,
        [key]: false,
      });
      await expect(requireNativeRenderPolicy(request, ctx, { artifactId: "a" })).rejects.toThrow(
        "FEATURE_UNAVAILABLE",
      );
    }
    m.policy.mockResolvedValue({});
    await expect(requireNativeRenderPolicy(request, ctx, { masterId: "m" })).rejects.toThrow(
      "FEATURE_UNAVAILABLE",
    );
  });
});
