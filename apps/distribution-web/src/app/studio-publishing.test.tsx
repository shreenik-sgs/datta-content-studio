import { studioClosingCardPlan } from "@satsang/distribution-domain";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioDetail } from "../lib/studio-model";
import { StudioPublishing } from "./studio-publishing";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function detail(isTest = false): StudioDetail {
  return {
    package: { ...value, status: "APPROVED", isTest },
    blockers: [],
    publications: [],
    readiness: {
      isTest,
      generation: {
        available: true,
        transcription: "test",
        intelligence: "test",
        translation: true,
        reason: null,
      },
      channels: [
        {
          channel: "youtube",
          label: "YouTube Shorts",
          ready: false,
          reason: "CHANNEL_NOT_CONNECTED",
          accountId: null,
          transport: "buffer",
        },
        {
          channel: "facebook",
          label: "Facebook",
          ready: false,
          reason: "CHANNEL_NOT_CONNECTED",
          accountId: null,
          transport: "buffer",
        },
      ],
    },
  };
}
async function render(
  data: StudioDetail,
  check: (
    host: HTMLElement,
    publish: ReturnType<typeof vi.fn>,
    refresh: ReturnType<typeof vi.fn>,
  ) => Promise<void> | void,
  permissions = { canPublish: true, canManage: true },
) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const publish = vi.fn();
  const refresh = vi.fn();
  try {
    await act(async () =>
      root.render(
        <StudioPublishing
          detail={data}
          {...permissions}
          busy={false}
          onPublish={publish}
          onRefresh={refresh}
        />,
      ),
    );
    await check(host, publish, refresh);
  } finally {
    await act(async () => root.unmount());
  }
}
const post = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) =>
    /^(Publish approved|Run test)/.test(b.textContent ?? ""),
  );
it("explains missing setup only for included destinations and links Admin settings", async () => {
  await render(detail(), async (host, publish, refresh) => {
    expect(host.textContent).toContain("YouTube Shorts · 1 file");
    expect(host.textContent).not.toContain("Facebook");
    expect(host.textContent).toContain("connect the Ashrama's verified account");
    expect(host.querySelector('a[href="/distribution/settings"]')).not.toBeNull();
    expect(post(host)?.disabled).toBe(true);
    await act(async () => post(host)?.click());
    expect(publish).not.toHaveBeenCalled();
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Refresh publishing status")
        ?.click(),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});
it.each([
  "STUDIO_PUBLISHING_DISABLED",
  "STUDIO_PUBLIC_MEDIA_NOT_CONFIGURED",
  "ACCOUNT_ELIGIBILITY_REQUIRED",
])("explains %s and blocks live publishing", async (reason) => {
  const data = detail();
  data.readiness.channels = data.readiness.channels.map((c) => ({ ...c, reason }));
  await render(data, (host) => {
    expect(post(host)?.disabled).toBe(true);
    expect(host.textContent).not.toContain(reason);
    expect(host.textContent).toMatch(/disabled|media delivery|eligibility/);
  });
});
it("keeps TEST simulation available without credentials, never labels it a live post", async () => {
  await render(detail(true), async (host, publish) => {
    expect(host.textContent).toContain("Test workspace — no videos will be posted");
    expect(host.textContent).toContain("No publishing account is saved");
    expect(post(host)?.textContent).toBe("Run test publication");
    expect(post(host)?.disabled).toBe(false);
    await act(async () => post(host)?.click());
    expect(publish).toHaveBeenCalledOnce();
  });
});
it("offers live publishing only after approval, readiness and explicit click", async () => {
  const data = detail();
  data.readiness.channels = data.readiness.channels.map((c) => ({
    ...c,
    ready: true,
    reason: null,
  }));
  await render(data, async (host, publish) => {
    expect(post(host)?.disabled).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await act(async () => post(host)?.click());
    expect(publish).toHaveBeenCalledOnce();
  });
  data.package.status = "IN_REVIEW";
  await render(data, (host) => {
    expect(post(host)).toBeUndefined();
    expect(host.textContent).toContain("generated files still need package approval");
  });
});
it("does not publish a new channel's card through an otherwise ready source connection", async () => {
  const data = detail();
  data.readiness.channels = data.readiness.channels.map((c) => ({
    ...c,
    ready: true,
    reason: null,
  }));
  data.package.outputs = data.package.outputs.map((o) => ({
    ...o,
    presentationReview: {
      policy: "source-safe-portrait-v1",
      sourceSha256: data.package.source.sha256,
      renderedSha256: o.asset?.sha256 ?? "a".repeat(64),
      fileVersion: 1,
      model: "fixture",
      reviewedAt: data.package.updatedAt,
      framing: "full-picture",
      repairs: 0,
      source: {
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Fixture",
        scenes: [],
      },
      checks: {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Fixture",
      },
      closingCard: studioClosingCardPlan(2000, {
        destination: "youtube",
        sourceBranding: "bala-swamiji",
      }),
    },
  }));
  await render(data, async (host, publish) => {
    expect(host.textContent).toContain("Sri Datta Vijayananda Teertha Swamiji");
    expect(post(host)?.disabled).toBe(true);
    await act(async () => post(host)?.click());
    expect(publish).not.toHaveBeenCalled();
  });
});
it("keeps package blockers and role boundaries visible", async () => {
  const data = detail(true);
  data.blockers = ["APPROVAL_STALE"];
  await render(
    data,
    (host) => {
      expect(post(host)?.disabled).toBe(true);
      expect(host.textContent).toContain("master approval is out of date");
      expect(host.querySelector('a[href="/distribution/settings"]')).toBeNull();
      expect(host.textContent).toContain("Ask an Admin");
    },
    { canPublish: true, canManage: false },
  );
  await render(
    data,
    (host) => {
      expect(post(host)).toBeUndefined();
    },
    { canPublish: false, canManage: false },
  );
});
it.each(["QUEUED", "UNCERTAIN", "SIMULATED"] as const)(
  "shows %s receipt and prevents duplicate requests",
  async (status) => {
    const data = detail(true);
    data.publications = [
      {
        id: "receipt",
        isTest: true,
        packageId: value.id,
        packageRevision: value.revision,
        outputId: "output-one",
        channel: "youtube",
        status,
        attempt: 1,
        error: null,
        remoteId: null,
        remoteUrl: null,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      },
    ];
    await render(data, (host) => {
      expect(post(host)?.disabled).toBe(true);
      expect(host.textContent).toContain("Daily practice");
      if (status === "SIMULATED")
        expect(host.textContent).toContain("Nothing was posted externally");
    });
  },
);

it("preselects the default, submits the chosen alternative and locks a queued destination", async () => {
  const data = detail();
  const connection = data.readiness.channels[0];
  if (!connection) throw Error("MISSING_CONNECTION");
  connection.accounts = [
    {
      id: "first",
      label: "@DattaSannidhi",
      isDefault: true,
      ready: true,
      reason: null,
      privacy: "private",
    },
    {
      id: "second",
      label: "Other channel",
      isDefault: false,
      ready: true,
      reason: null,
      privacy: "public",
    },
  ];
  await render(data, async (host, publish) => {
    const selector = host.querySelector("select");
    expect(selector?.value).toBe("first");
    expect(host.textContent).toContain("YouTube visibility: private");
    await act(async () => {
      if (selector) {
        selector.value = "second";
        selector.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(host.textContent).toContain("YouTube visibility: public");
    await act(async () => post(host)?.click());
    expect(publish).toHaveBeenCalledWith({ youtube: "second" });
  });
  data.publications = [
    {
      id: "receipt",
      isTest: false,
      packageId: value.id,
      packageRevision: value.revision,
      outputId: "output-one",
      channel: "youtube",
      status: "QUEUED",
      selectedAccountId: "second",
      attempt: 0,
      error: null,
      remoteId: null,
      remoteUrl: null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  ];
  await render(data, (host) => {
    expect(host.querySelector("select")?.value).toBe("second");
    expect(host.querySelector("select")?.disabled).toBe(true);
    expect(post(host)?.disabled).toBe(true);
  });
});
