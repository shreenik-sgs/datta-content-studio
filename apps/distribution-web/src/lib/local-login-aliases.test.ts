import { expect, it } from "vitest";
import { localStudioLoginAliases, studioLoginIdentifier } from "./auth";
const env = {
  DISTRIBUTION_APP_ORIGIN: "http://localhost:3020",
  DISTRIBUTION_HUB_STAGE: "TEST",
  STUDIO_LOCAL_LOGIN_ALIASES_JSON: JSON.stringify({ Curator: "curator@studio.test" }),
};
it("maps configured local usernames to the same email identity and rate limit key", () => {
  const aliases = localStudioLoginAliases(env);
  expect(studioLoginIdentifier(" CURATOR ", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("curator@studio.test", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("unknown", aliases)).toBe("unknown");
  expect(studioLoginIdentifier("constructor", aliases)).toBe("constructor");
});
it("never enables local aliases on hosted or non-TEST environments", () => {
  expect(
    localStudioLoginAliases({ ...env, DISTRIBUTION_APP_ORIGIN: "https://studio.example.com" }),
  ).toEqual({});
  expect(localStudioLoginAliases({ ...env, DISTRIBUTION_HUB_STAGE: "ON" })).toEqual({});
});
it.each(["invalid json", "null", "[]", '{"admin":"not-an-email"}'])(
  "handles invalid alias configuration: %s",
  (value) => {
    expect(localStudioLoginAliases({ ...env, STUDIO_LOCAL_LOGIN_ALIASES_JSON: value })).toEqual({});
  },
);
