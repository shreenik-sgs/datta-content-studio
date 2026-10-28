import type { PostingCheck } from "@satsang/distribution-domain";
import { describe, expect, it } from "vitest";
import type { PublicStudioPublication } from "./studio-model";
import { studioPostingState } from "./studio-posting-state";

const pkg = { id: "package", isTest: false, revision: 5 };
const output = { id: "output", channel: "youtube" as const };
const receipt: PublicStudioPublication = {
  id: "receipt",
  packageId: pkg.id,
  packageRevision: 5,
  outputId: output.id,
  channel: "youtube",
  isTest: false,
  status: "PUBLISHED",
  selectedAccountId: "guru",
  attempt: 1,
  error: null,
  errorDetail: null,
  remoteId: "video",
  remoteUrl: "https://www.youtube.com/watch?v=example",
  createdAt: "2026-10-23T01:00:00Z",
  updatedAt: "2026-10-23T01:01:00Z",
};
const result: PostingCheck = {
  destination: "youtube:channel",
  checkedAt: "2026-10-23T02:00:00Z",
  scanned: 20,
  error: null,
  matches: [],
};

describe("series posting visibility", () => {
  it("counts only current, live, same-output, same-account receipts as posted", () => {
    expect(studioPostingState(pkg, output, [receipt], { accountId: "guru" })).toMatchObject({
      key: "posted",
      label: "Posted",
      url: receipt.remoteUrl,
      postedAt: receipt.updatedAt,
    });
    for (const change of [
      { packageId: "other" },
      { outputId: "other" },
      { channel: "facebook" as const },
      { isTest: true },
      { selectedAccountId: "other" },
      { packageRevision: 6 },
    ])
      expect(
        studioPostingState(pkg, output, [{ ...receipt, ...change }], { accountId: "guru" }).key,
      ).toBe("not_posted");
  });
  it("does not imply a channel is empty when no Studio receipt exists", () => {
    expect(studioPostingState(pkg, output, []).detail).toContain(
      "outside Studio have not been checked",
    );
    expect(studioPostingState(pkg, output, []).label).toBe("No Studio posting record");
  });
  it("separates older uploads from the edited current file", () => {
    const state = studioPostingState(pkg, output, [{ ...receipt, packageRevision: 4 }]);
    expect(state.key).toBe("earlier_version");
    expect(state.detail).toContain("Revision 4 was posted");
    expect(state.detail).toContain("current revision 5 has no Studio publication receipt");
    expect(state.url).toBe(receipt.remoteUrl);
  });
  it("never presents TEST receipts or simulations as a live posting", () => {
    const test = { ...pkg, isTest: true };
    expect(
      studioPostingState(test, output, [{ ...receipt, isTest: true, status: "SIMULATED" }]),
    ).toMatchObject({ key: "simulated", url: null, postedAt: null });
    expect(studioPostingState(test, output, [{ ...receipt, isTest: true }])).toMatchObject({
      key: "attention",
      label: "Test receipt needs checking",
      url: null,
    });
  });
  it.each(["QUEUED", "RUNNING", "PROCESSING"] as const)(
    "shows %s as pending, not posted",
    (status) => {
      expect(studioPostingState(pkg, output, [{ ...receipt, status }])).toMatchObject({
        key: "queued",
        postedAt: null,
      });
    },
  );
  it.each(["BLOCKED", "FAILED", "UNCERTAIN"] as const)(
    "shows %s as needing attention",
    (status) => {
      expect(studioPostingState(pkg, output, [{ ...receipt, status }]).key).toBe("attention");
    },
  );
  it("does not equate cancellation with removal on YouTube", () => {
    const state = studioPostingState(pkg, output, [{ ...receipt, status: "CANCELLED" }]);
    expect(state.key).toBe("cancelled");
    expect(state.detail).toContain("does not verify removal");
  });
  it("shows similar channel metadata as a possible duplicate, never confirmed posted", () => {
    const check = {
      accountId: "guru",
      result: {
        ...result,
        matches: [
          {
            state: "NEEDS_REVIEW",
            reason: "SIMILAR_METADATA",
            origin: "channel",
            url: receipt.remoteUrl,
            postedAt: null,
          },
        ] as PostingCheck["matches"],
      },
    };
    const state = studioPostingState(pkg, output, [], { accountId: "guru", check });
    expect(state).toMatchObject({
      key: "attention",
      label: "Possible existing post",
      url: receipt.remoteUrl,
      postedAt: null,
    });
    expect(studioPostingState(pkg, output, [], { accountId: "other", check }).key).toBe(
      "not_posted",
    );
  });
  it("makes an incomplete external check actionable and never declares no matches", () => {
    expect(
      studioPostingState(pkg, output, [], {
        accountId: "guru",
        check: {
          accountId: "guru",
          result: { ...result, error: "STUDIO_POSTING_CHECK_INCOMPLETE" },
        },
      }),
    ).toMatchObject({ key: "attention", label: "Channel check incomplete" });
    expect(
      studioPostingState(pkg, output, [], {
        accountId: "guru",
        check: { accountId: "guru", result },
      }).detail,
    ).toContain("Uploads outside the available history may still exist");
  });
  it("does not expose unsafe remote receipt links", () => {
    for (const remoteUrl of [
      "javascript:alert(1)",
      "https://user:password@example.com",
      "not-a-url",
    ])
      expect(studioPostingState(pkg, output, [{ ...receipt, remoteUrl }]).url).toBeNull();
  });
});

it("shows the channel's own reason on a failed posting request", () => {
  const failed: PublicStudioPublication = {
    ...receipt,
    id: "failed",
    status: "FAILED",
    error: "BUFFER_PUBLISH_FAILED",
    errorDetail: "You've hit the daily video upload limit for an unverified YouTube account.",
    remoteId: "buffer-rejected",
    remoteUrl: null,
  };
  const state = studioPostingState(pkg, output, [failed], { accountId: "guru" });
  expect(state.label).toBe("Posting failed");
  expect(state.detail).toContain(
    "The channel reported: \u201cYou've hit the daily video upload limit",
  );
});
