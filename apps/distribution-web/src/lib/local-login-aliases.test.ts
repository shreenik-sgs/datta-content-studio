import { expect, it } from "vitest";
import { studioLoginAliases, studioLoginIdentifier } from "./auth";
const env = {
  DISTRIBUTION_APP_ORIGIN: "http://localhost:3020",
  DISTRIBUTION_HUB_STAGE: "TEST",
  STUDIO_LOCAL_LOGIN_ALIASES_JSON: JSON.stringify({ Curator: "curator@studio.test" }),
};
it("maps configured local usernames to the same email identity and rate limit key", () => {
  const aliases = studioLoginAliases(env);
  expect(studioLoginIdentifier(" CURATOR ", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("curator@studio.test", aliases)).toBe("curator@studio.test");
  expect(studioLoginIdentifier("unknown", aliases)).toBe("unknown");
  expect(studioLoginIdentifier("constructor", aliases)).toBe("constructor");
});
it("never enables local aliases on hosted or non-TEST environments", () => {
  expect(
    studioLoginAliases({ ...env, DISTRIBUTION_APP_ORIGIN: "https://studio.example.com" }),
  ).toEqual({});
  expect(studioLoginAliases({ ...env, DISTRIBUTION_HUB_STAGE: "ON" })).toEqual({});
});
it("allows separately configured hosted TEST usernames without enabling them for live users", () => {
  const hosted = {
    ...env,
    DISTRIBUTION_APP_ORIGIN: "https://studio-staging.example.com",
    STUDIO_TEST_LOGIN_ALIASES_JSON: JSON.stringify({ Approver: "approver@studio.test" }),
  };
  expect(studioLoginAliases(hosted)).toEqual({ approver: "approver@studio.test" });
  expect(studioLoginAliases({ ...hosted, DISTRIBUTION_HUB_STAGE: "ON" })).toEqual({});
  expect(studioLoginAliases({ ...hosted, DISTRIBUTION_HUB_STAGE: "LIMITED" })).toEqual({});
  expect(
    studioLoginAliases({
      ...hosted,
      DISTRIBUTION_APP_ORIGIN: "http://studio-staging.example.com",
    }),
  ).toEqual({});
  expect(studioLoginAliases({ ...hosted, ...env })).toEqual({ curator: "curator@studio.test" });
});
it.each(["invalid json", "null", "[]", '{"admin":"not-an-email"}'])(
  "handles invalid alias configuration: %s",
  (value) => {
    expect(studioLoginAliases({ ...env, STUDIO_LOCAL_LOGIN_ALIASES_JSON: value })).toEqual({});
  },
);
it("preserves explicitly configured live usernames without inheriting TEST aliases", () => {
  const live = {
    ...env,
    DISTRIBUTION_APP_ORIGIN: "https://gbadpt.sgsdattasannidhi.org",
    STUDIO_TEST_LOGIN_ALIASES_JSON: JSON.stringify({ Admin: "test@studio.test" }),
    STUDIO_LIVE_LOGIN_ALIASES_JSON: JSON.stringify({ Curator: "curator@live.example" }),
  };
  for (const stage of ["ON", "LIMITED"]) {
    const aliases = studioLoginAliases({ ...live, DISTRIBUTION_HUB_STAGE: stage });
    expect(aliases).toEqual({ curator: "curator@live.example" });
    expect(studioLoginIdentifier(" CURATOR ", aliases)).toBe("curator@live.example");
    expect(studioLoginIdentifier("curator@live.example", aliases)).toBe("curator@live.example");
    expect(studioLoginIdentifier("admin", aliases)).toBe("admin");
  }
  expect(studioLoginAliases(live)).toEqual({ admin: "test@studio.test" });
  for (const stage of ["OFF", "invalid", ""]) {
    expect(studioLoginAliases({ ...live, DISTRIBUTION_HUB_STAGE: stage })).toEqual({});
  }
});
