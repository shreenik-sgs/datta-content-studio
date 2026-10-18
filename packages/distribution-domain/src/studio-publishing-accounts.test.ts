import { expect, it } from "vitest";
import { studioDefaultAccount, studioPublishingAccounts } from "./intelligent-content";
const accounts = [
  { id: "one", platform: "youtube" as const, isDefault: true },
  { id: "two", platform: "youtube" as const },
  { id: "fb", platform: "facebook" as const },
];
it("resolves defaults and explicit choices by platform", () => {
  expect(studioPublishingAccounts(accounts, ["youtube", "facebook"], {}, false)).toEqual({
    youtube: "one",
    facebook: "fb",
  });
  expect(studioPublishingAccounts(accounts, ["youtube"], { youtube: "two" }, false)).toEqual({
    youtube: "two",
  });
  expect(studioDefaultAccount(accounts, "youtube")?.id).toBe("one");
  expect(studioPublishingAccounts([], ["youtube"], {}, true)).toEqual({});
});
it("rejects forged, cross-platform and excluded-channel choices even in TEST", () => {
  for (const selected of [
    { youtube: "unknown" },
    { youtube: "fb" },
    { facebook: "fb" },
    { website: "one" },
  ])
    expect(() => studioPublishingAccounts(accounts, ["youtube"], selected, true)).toThrow(
      "STUDIO_PUBLISH_ACCOUNT_INVALID",
    );
  expect(() => studioPublishingAccounts([], ["youtube"], {}, false)).toThrow(
    "STUDIO_PUBLISH_ACCOUNT_REQUIRED",
  );
  expect(() =>
    studioPublishingAccounts(
      accounts.map((a) => ({ ...a, isDefault: false })),
      ["youtube"],
      {},
      false,
    ),
  ).toThrow("STUDIO_PUBLISH_ACCOUNT_REQUIRED");
});
