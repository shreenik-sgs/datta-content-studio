import { expect, it } from "vitest";
import { studioLoginIdentifier, studioTestLoginAliases } from "./auth";
const env = {
  DISTRIBUTION_APP_ORIGIN: "http://localhost:3020",
  DISTRIBUTION_HUB_STAGE: "TEST",
  STUDIO_LOCAL_LOGIN_ALIASES_JSON: JSON.stringify({ Curator: "curator@studio.test" }),
};
it("maps configured local usernames to the same email identity and rate limit key", () => {
  const aliases = studioTestLoginAliases(env);
  expect(studioLoginIdentifier(" CURATOR ", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("curator@studio.test", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("unknown", aliases)).toBe("unknown");
  expect(studioLoginIdentifier("constructor", aliases)).toBe("constructor");
});
it("never enables local aliases on hosted or non-TEST environments", () => {
  expect(
    studioTestLoginAliases({ ...env, DISTRIBUTION_APP_ORIGIN: "https://studio.example.com" }),
  ).toEqual({});
  expect(studioTestLoginAliases({ ...env, DISTRIBUTION_HUB_STAGE: "ON" })).toEqual({});
});
it("allows separately configured hosted TEST usernames without enabling them for live users", () => {
  const hosted = {
    ...env,
    DISTRIBUTION_APP_ORIGIN: "https://studio-staging.example.com",
    STUDIO_TEST_LOGIN_ALIASES_JSON: JSON.stringify({ Approver: "approver@studio.test" }),
  };
  expect(studioTestLoginAliases(hosted)).toEqual({ approver: "approver@studio.test" });
  expect(studioTestLoginAliases({ ...hosted, DISTRIBUTION_HUB_STAGE: "ON" })).toEqual({});
  expect(studioTestLoginAliases({ ...hosted, DISTRIBUTION_HUB_STAGE: "LIMITED" })).toEqual({});
  expect(
    studioTestLoginAliases({
      ...hosted,
      DISTRIBUTION_APP_ORIGIN: "http://studio-staging.example.com",
    }),
  ).toEqual({});
  expect(studioTestLoginAliases({ ...hosted, ...env })).toEqual({ curator: "curator@studio.test" });
});
it.each(["invalid json", "null", "[]", '{"admin":"not-an-email"}'])(
  "handles invalid alias configuration: %s",
  (value) => {
    expect(studioTestLoginAliases({ ...env, STUDIO_LOCAL_LOGIN_ALIASES_JSON: value })).toEqual({});
  },
);
