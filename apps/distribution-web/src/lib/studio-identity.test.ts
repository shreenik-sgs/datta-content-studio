import { describe, expect, it } from "vitest";
import { studioIdentity } from "./studio-identity";

describe("deployment identity", () => {
  it.each([
    ["gbadpt", "Guru Bhavana", "sri-bala-swamiji-portrait.jpg"],
    ["dp", "Datta Peetham", "sgsswamiji-channel-avatar.jpg"],
  ])("selects %s only from trusted deployment configuration", (id, organization, asset) => {
    expect(studioIdentity({ STUDIO_IDENTITY: id })).toMatchObject({
      id,
      organization,
      logo: `/distribution/brand/${asset}`,
    });
    expect(
      studioIdentity({ DISTRIBUTION_APP_ORIGIN: `https://${id}.sgsdattasannidhi.org` }),
    ).toMatchObject({ id, organization });
  });

  it("keeps unconfigured installations neutral", () => {
    for (const origin of [undefined, "http://localhost:3070", "https://dp.example.com", "invalid"])
      expect(studioIdentity({ DISTRIBUTION_APP_ORIGIN: origin })).toMatchObject({
        id: null,
        logo: null,
        organization: null,
      });
  });

  it("supports the existing local GBADPT media workspace without hostname impersonation", () => {
    expect(
      studioIdentity({
        STUDIO_IDENTITY: "gbadpt",
        DISTRIBUTION_APP_ORIGIN: "http://localhost:3070",
        HOST: "dp.sgsdattasannidhi.org",
      }),
    ).toMatchObject({ id: "gbadpt" });
  });

  it.each(["gbadpt", "dp"])("rejects an identity conflicting with %s's origin", (id) => {
    expect(() =>
      studioIdentity({
        STUDIO_IDENTITY: id === "dp" ? "gbadpt" : "dp",
        DISTRIBUTION_APP_ORIGIN: `https://${id}.sgsdattasannidhi.org`,
      }),
    ).toThrow("does not match");
  });

  it("rejects invalid identity configuration", () => {
    expect(() => studioIdentity({ STUDIO_IDENTITY: "other" })).toThrow("must be gbadpt or dp");
  });
});
