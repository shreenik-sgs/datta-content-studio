import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ config: vi.fn(), readiness: vi.fn() }));
vi.mock("@satsang/distribution-db", () => ({
  createIntelligentContentRepository: vi.fn(),
  createStudioRoleAuthority: vi.fn(),
  loadStudioProviderConfig: m.config,
  studioSettingsPath: (env: NodeJS.ProcessEnv, isTest: boolean) =>
    isTest ? env.STUDIO_CHANNEL_CONFIG_TEST_FILE : env.STUDIO_CHANNEL_CONFIG_FILE,
  studioProviderReadiness: m.readiness,
}));
vi.mock("./runtime", () => ({ distributionPool: vi.fn() }));
import { studioMessage } from "./studio-model";
import { studioReadiness } from "./studio-runtime";

describe("Studio readiness matches publication requirements", () => {
  beforeEach(() => {
    m.config.mockResolvedValue({
      version: 1,
      accounts: [],
      trustedMediaOrigins: ["https://ashrama.example"],
    });
    m.readiness.mockReturnValue(
      ["instagram", "telegram", "reddit"].map((channel) => ({
        channel,
        label: channel,
        ready: true,
        reason: null,
        accountId: "configured-account",
        transport: channel,
        accounts: [{ accountId: "configured-account", ready: true, reason: null }],
      })),
    );
    vi.stubEnv("STUDIO_PUBLISHING_ENABLED", "true");
    vi.stubEnv("STUDIO_PUBLIC_ORIGIN", "https://ashrama.example");
    vi.stubEnv(
      "STUDIO_MEDIA_SIGNING_SECRET",
      "synthetic-test-secret-that-is-more-than-thirty-two-characters",
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  it("requires the exact origin used by signed media and blog publishing", async () => {
    let result = await studioReadiness({ isTest: false });
    expect(result.channels.every((channel) => channel.ready)).toBe(true);
    vi.stubEnv("STUDIO_PUBLIC_ORIGIN", "https://ashrama.example/");
    result = await studioReadiness({ isTest: false });
    expect(result.channels.find((channel) => channel.channel === "website")?.ready).toBe(false);
    expect(result.channels.find((channel) => channel.channel === "instagram")?.reason).toBe(
      "STUDIO_PUBLIC_MEDIA_NOT_CONFIGURED",
    );
  });
  it("requires secure media delivery for Telegram image posts while Reddit remains text only", async () => {
    vi.stubEnv("STUDIO_MEDIA_SIGNING_SECRET", "");
    const result = await studioReadiness({ isTest: false });
    expect(result.channels.find((channel) => channel.channel === "telegram")?.reason).toBe(
      "STUDIO_PUBLIC_MEDIA_NOT_CONFIGURED",
    );
    expect(result.channels.find((channel) => channel.channel === "reddit")?.ready).toBe(true);
  });
  it("never marks TEST connections ready for external posting", async () => {
    const result = await studioReadiness({ isTest: true });
    expect(
      result.channels.every(
        (channel) => !channel.ready && channel.reason === "TEST_NETWORK_DISABLED",
      ),
    ).toBe(true);
  });
  it.each([[], ["https://another.example"], ["https://ashrama.example/files"]])(
    "blocks media posting until the exact public origin is allowed: %j",
    async (...origins) => {
      m.config.mockResolvedValue({ version: 1, accounts: [], trustedMediaOrigins: origins });
      const result = await studioReadiness({ isTest: false });
      for (const name of ["instagram", "telegram"]) {
        const channel = result.channels.find((item) => item.channel === name);
        expect(channel?.ready).toBe(false);
        expect(channel?.reason).toBe("APPROVED_MEDIA_URL_REQUIRED");
        expect(channel?.accounts?.[0]).toMatchObject({
          ready: false,
          reason: "APPROVED_MEDIA_URL_REQUIRED",
        });
      }
      expect(result.channels.find((item) => item.channel === "reddit")?.ready).toBe(true);
      expect(result.channels.find((item) => item.channel === "website")?.ready).toBe(true);
    },
  );
  it("retains configuration and connection errors ahead of a media-origin warning", async () => {
    m.config.mockRejectedValue(new Error("CONFIG_INVALID"));
    const result = await studioReadiness({ isTest: false });
    expect(result.channels.find((item) => item.channel === "youtube")?.reason).toBe(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
  });
  it("explains where an Admin can resolve blocked media delivery", () => {
    expect(studioMessage("APPROVED_MEDIA_URL_REQUIRED")).toContain("Media delivery settings");
    expect(studioMessage("APPROVED_MEDIA_URL_REQUIRED")).toContain("did not upload");
  });
  it("gives an actionable recovery for a source without configured transcription", () => {
    expect(studioMessage("TRANSCRIPTION_NOT_CONFIGURED")).toContain("Editorial review");
    expect(studioMessage("TRANSCRIPTION_NOT_CONFIGURED")).toContain("regenerate");
    expect(studioMessage("NOT_APPROVED")).toBe(
      "A Content Approver must approve the master source before this package can be approved.",
    );
    expect(studioMessage("STUDIO_NOT_APPROVED")).toContain("current package before publication");
  });
});
