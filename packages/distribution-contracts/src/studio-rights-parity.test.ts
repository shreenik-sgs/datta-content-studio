import { STUDIO_CHANNELS } from "@satsang/distribution-domain";
import { expect, it } from "vitest";
import { contentRightsSchema } from "./content";

it("accepts every destination offered by the Studio master permissions form", () => {
  const rights = contentRightsSchema.parse({
    owner: "Ashrama",
    territories: ["WORLDWIDE"],
    channels: ["manual_export", ...STUDIO_CHANNELS],
    authorizationBasis: "Authorized channel derivation and distribution",
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  });
  expect(rights.channels).toContain("whatsapp");
  expect(rights.channels).toHaveLength(STUDIO_CHANNELS.length + 1);
});
