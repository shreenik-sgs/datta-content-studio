import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  authority: vi.fn(),
  render: vi.fn(),
  activation: vi.fn(),
  pool: {},
}));
vi.mock("@satsang/distribution-db", () => ({
  createDistributionRoleAuthority: m.authority,
  createDistributionRenderRepository: m.render,
  createDistributionActivationRepository: m.activation,
  createDistributionOutreachRepository: vi.fn(),
}));
vi.mock("./runtime", () => ({ distributionPool: () => m.pool }));
import { activationRepository } from "./outreach-runtime";
import { renderRepository } from "./render-runtime";

describe("local TEST role authority composition", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it.each(["OFF", "PROD", "PRODUCTION", "SHADOW", ""])(
    "never constructs a local authority in %s",
    (stage) => {
      vi.stubEnv("DISTRIBUTION_HUB_STAGE", stage);
      renderRepository();
      activationRepository();
      expect(m.authority).not.toHaveBeenCalled();
      expect(m.render).toHaveBeenCalledWith(m.pool, {});
      expect(m.activation).toHaveBeenCalledWith(m.pool, {});
    },
  );
  it("provides the fail-closed authority only to TEST repositories", () => {
    vi.stubEnv("DISTRIBUTION_HUB_STAGE", "TEST");
    const authorize = vi.fn().mockRejectedValue(new Error("OPERATOR_AUTHORITY_UNAVAILABLE"));
    m.authority.mockReturnValue(authorize);
    renderRepository();
    activationRepository();
    expect(m.render).toHaveBeenCalledWith(m.pool, { authorize });
    expect(m.activation).toHaveBeenCalledWith(m.pool, { authorize });
    expect(authorize).not.toHaveBeenCalled();
  });
});
