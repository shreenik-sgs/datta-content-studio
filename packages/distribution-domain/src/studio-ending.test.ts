import { expect, it } from "vitest";
import {
  studioClosingCardPlan,
  studioClosingChannel,
  unconfiguredStudioClosingChannels,
  validateStudioClosingCard,
} from "./studio-ending";
import { safeStudioPortraitScenes } from "./studio-presentation";
it("does not map a source channel or parent account to an uncreated destination", () => {
  for (const target of [
    { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" },
    { label: "AvadhootaDattaPeetham", url: "https://www.youtube.com/@AvadhootaDattaPeetham" },
  ]) {
    const card = studioClosingCardPlan(60000, {
      sourceBranding: "bala-swamiji",
      youtubeClosing: target,
    });
    expect(studioClosingChannel(card)).toEqual({ name: "Sri Datta Vijayananda Teertha Swamiji" });
    expect(studioClosingChannel({ ...card, policy: "clean-hold-closing-card-v2" })).toEqual({
      name: target.label,
      url: target.url,
    });
  }
  expect(studioClosingChannel(studioClosingCardPlan(60000, { destination: "youtube" }))).toEqual({
    name: "SriSwamiji",
  });
  const target = {
    label: "Sri Datta Vijayananda Teertha Swamiji",
    url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  };
  expect(
    studioClosingChannel(
      studioClosingCardPlan(60000, { sourceBranding: "bala-swamiji", youtubeClosing: target }),
    ),
  ).toEqual({ name: target.label, url: target.url });
});
it("shows the closing image during the final words without changing the source duration", () => {
  const plan = studioClosingCardPlan(84420);
  expect(plan).toMatchObject({
    startMs: 82420,
    endMs: 87420,
    speechEndMs: 84420,
    cleanHoldMs: 3000,
    transitionMs: 400,
  });
  expect(() => validateStudioClosingCard(plan, 84420)).not.toThrow();
});
it("requires destinations only for included subscription cards", () => {
  const pending = {
    included: true,
    presentationReview: {
      closingCard: studioClosingCardPlan(60000, {
        destination: "youtube",
        sourceBranding: "bala-swamiji",
      }),
    },
  };
  expect(unconfiguredStudioClosingChannels([pending, pending])).toEqual([
    "Sri Datta Vijayananda Teertha Swamiji",
  ]);
  expect(unconfiguredStudioClosingChannels([{ ...pending, included: false }])).toEqual([]);
  expect(
    unconfiguredStudioClosingChannels([
      { included: true, presentationReview: { closingCard: studioClosingCardPlan(60000) } },
    ]),
  ).toEqual([]);
});
it.each([Number.NaN, 999, -1, 1200.5])("rejects invalid source duration %s", (duration) => {
  expect(() => studioClosingCardPlan(duration)).toThrow("STUDIO_CLOSING_CARD_INVALID");
});
it("rejects altered timing or a substituted outbound link", () => {
  const plan = studioClosingCardPlan(84420);
  for (const change of [{ startMs: 100 }, { endMs: 84000 }, { moreUrl: "https://other.invalid" }])
    expect(() => validateStudioClosingCard({ ...plan, ...change } as typeof plan, 84420)).toThrow();
});

it("bridges the poster once into the screened portrait without cutting opening words", async () => {
  const { studioOpeningCardPlan, validateStudioOpeningCard } = await import("./studio-ending");
  const scenes = [{ startMs: 7500, endMs: 33920 }];
  const plan = studioOpeningCardPlan(33920, scenes);
  if (!plan) throw Error("Expected opening bridge");
  expect(plan).toMatchObject({ startMs: 0, transitionStartMs: 7500, endMs: 7900 });
  expect(() => validateStudioOpeningCard(plan, 33920, scenes)).not.toThrow();
  expect(studioOpeningCardPlan(33920, [{ startMs: 0, endMs: 33920 }])).toBeUndefined();
  expect(() =>
    validateStudioOpeningCard({ ...plan, transitionStartMs: 6500 }, 33920, scenes),
  ).toThrow();
  expect(() => studioOpeningCardPlan(33920, [{ startMs: 12000, endMs: 33920 }])).toThrow();
  expect(() => studioOpeningCardPlan(9000, [{ startMs: 7500, endMs: 9000 }])).toThrow();
});

it("selects stable visual variants and device links with website fallback", async () => {
  const { studioCardStyle, studioAppLinks, studioAppDestination } = await import("./studio-ending");
  const styles = new Set(
    Array.from({ length: 100 }, (_, i) => studioCardStyle(`master:message-${i}`)),
  );
  expect(styles.size).toBe(3);
  expect(studioCardStyle("same-teaching")).toBe(studioCardStyle("same-teaching"));
  const fallback = studioAppLinks();
  expect(studioAppDestination(fallback, "ios")).toBe("https://sgsdattasannidhi.org/");
  expect(studioAppDestination(fallback, "android")).toBe(fallback.web);
  const links = studioAppLinks({
    web: fallback.web,
    ios: "https://apps.apple.com/app/id123",
    android: "https://play.google.com/store/apps/details?id=example",
  });
  expect(studioAppDestination(links, "ios")).toBe(links.ios);
  expect(studioAppDestination(links, "android")).toBe(links.android);
  expect(studioAppDestination(links, "web")).toBe(links.web);
  for (const web of [
    "javascript:alert(1)",
    "http://example.org",
    "https://user:password@example.org",
    "https://example.org/\n",
  ])
    expect(() => studioAppLinks({ web })).toThrow();
});

it.each([9500, 10000])(
  "keeps an opening bridge valid after the safety margin at %s ms",
  async (startMs) => {
    const { studioOpeningCardPlan, validateStudioOpeningCard } = await import("./studio-ending");
    const durationMs = 84420;
    const scenes = safeStudioPortraitScenes(
      {
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        openingCardRecommended: true,
        reason: "An introductory event poster precedes continuous speaker footage.",
        scenes: [{ startMs, endMs: durationMs, bodyTop: 0, bodyBottom: 0.88 }],
      },
      durationMs,
    );
    const plan = studioOpeningCardPlan(durationMs, scenes);
    if (!plan) throw Error("Expected opening bridge");
    expect(plan.transitionStartMs).toBe(startMs + 1000);
    expect(plan.endMs).toBe(startMs + 1400);
    expect(() => validateStudioOpeningCard(plan, durationMs, scenes)).not.toThrow();
    expect(() =>
      studioOpeningCardPlan(durationMs, [{ startMs: 11001, endMs: durationMs }]),
    ).toThrow();
  },
);
it("keeps legacy reviewed closing cards readable", () => {
  expect(() =>
    validateStudioClosingCard(
      {
        policy: "continuous-voice-closing-card-v1",
        startMs: 77920,
        endMs: 84420,
        transitionMs: 400,
        moreUrl: "https://sgsdattasannidhi.org/",
      },
      84420,
    ),
  ).not.toThrow();
});

it("validates saved links independently of JSON database key order", () => {
  const plan = studioClosingCardPlan(84420, {
    appLinks: {
      web: "https://sgsdattasannidhi.org/",
      ios: "https://apps.apple.com/app/id123",
      android: "https://play.google.com/store/apps/details?id=example",
    },
  });
  expect(() =>
    validateStudioClosingCard(
      {
        ...plan,
        appLinks: {
          android: "https://play.google.com/store/apps/details?id=example",
          ios: "https://apps.apple.com/app/id123",
          web: "https://sgsdattasannidhi.org/",
        },
      },
      84420,
    ),
  ).not.toThrow();
});

it("keeps the YouTube closing destination separate from app downloads", () => {
  const plan = studioClosingCardPlan(60000, { destination: "youtube" });
  expect(plan.channelUrl).toBe("https://www.youtube.com/@sgsswamiji");
  expect(plan.appLinks).toBeUndefined();
  expect(() => validateStudioClosingCard(plan, 60000)).not.toThrow();
  for (const change of [
    { channelUrl: "https://www.youtube.com/@someoneelse" },
    { appLinks: { web: "https://sgsdattasannidhi.org/" } },
    { destination: "app" as const },
  ])
    expect(() => validateStudioClosingCard({ ...plan, ...change }, 60000)).toThrow();
  const app = studioClosingCardPlan(60000, { destination: "app" });
  expect(app.appLinks?.web).toBe("https://sgsdattasannidhi.org/");
  expect(() =>
    validateStudioClosingCard({ ...app, channelUrl: "https://www.youtube.com/@sgsswamiji" }, 60000),
  ).toThrow();
});

it("binds a custom subscription label and channel without changing default cards", async () => {
  const { studioYoutubeClosing } = await import("./studio-ending");
  const target = { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" };
  expect(
    studioYoutubeClosing({
      ...target,
      label: " Gurubhavana ADPT ",
      url: "https://youtube.com/@gurubhavanaadpt/",
    }),
  ).toEqual(target);
  const plan = studioClosingCardPlan(60000, { youtubeClosing: target });
  expect(plan).toMatchObject({
    destination: "youtube",
    channelUrl: target.url,
    youtubeClosing: target,
  });
  expect(plan.appLinks).toBeUndefined();
  expect(() => validateStudioClosingCard(plan, 60000)).not.toThrow();
  expect(() =>
    validateStudioClosingCard(
      { ...plan, channelUrl: "https://www.youtube.com/@sgsswamiji" },
      60000,
    ),
  ).toThrow();
  expect(() =>
    studioClosingCardPlan(60000, { destination: "app", youtubeClosing: target }),
  ).toThrow();
  expect(studioClosingCardPlan(60000).youtubeClosing).toBeUndefined();
  for (const url of [
    "https://www.youtube.com/@gurubhavanaadpt?redirect=evil",
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com.evil.test/@gurubhavanaadpt",
    "https://user@youtube.com/@gurubhavanaadpt",
    "https://youtube.com:8443/@gurubhavanaadpt",
    "http://youtube.com/@gurubhavanaadpt",
    "javascript:alert(1)",
    "https://youtube.com/@gurubhavanaadpt#bad",
    "https://youtube.com/@guru\n",
  ])
    expect(() => studioYoutubeClosing({ ...target, url })).toThrow();
  for (const label of ["", "x".repeat(81), "<script>", "bad\nlabel"])
    expect(() => studioYoutubeClosing({ ...target, label })).toThrow();
});

it("uses green closing cards for the final five seconds while retaining legacy evidence", () => {
  const current = studioClosingCardPlan(60000, { style: "plum", destination: "youtube" });
  expect(current.style).toBe("forest");
  expect(current.endMs - current.startMs).toBe(5000);
  expect(() =>
    validateStudioClosingCard(
      { ...current, policy: "clean-hold-closing-card-v2", style: "dawn", startMs: 53500 },
      60000,
    ),
  ).not.toThrow();
});

it("preserves historical green-card evidence without treating its source as a new channel", () => {
  const card = {
    ...studioClosingCardPlan(60000, {
      sourceBranding: "bala-swamiji",
      youtubeClosing: {
        label: "Gurubhavana ADPT",
        url: "https://www.youtube.com/@gurubhavanaadpt",
      },
    }),
    policy: "green-subscribe-closing-card-v3" as const,
  };
  expect(() => validateStudioClosingCard(card, 60000)).not.toThrow();
  expect(studioClosingChannel(card)).toEqual({ name: "SriBalaSwamiji" });
});
