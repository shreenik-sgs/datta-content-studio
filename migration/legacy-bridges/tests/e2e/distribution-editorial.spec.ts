import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { distributionRoleFixture } from "./distribution-role-fixture";

const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const contentApi = `${origin}/distribution/api/content`;
const editorialApi = `${origin}/distribution/api/editorial`;

// A generated silent four-second WAV and unmistakably synthetic text. No
// recording, transcript or statement is attributed to Sri Swamiji by this test.
function silentWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 4 * 2;
  const result = Buffer.alloc(44 + dataSize);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + dataSize, 4);
  result.write("WAVE", 8);
  result.write("fmt ", 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataSize, 40);
  return result;
}

test.describe("DS-DIST-R2 local manual editorial acceptance", () => {
  test.skip(!enabled, "Explicit local Distribution E2E setup is required.");
  test("DS-DIST-R2 source, human review, exact quote and historical invalidation", async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => {
      void testInfo.attach("browser-error", { body: error.message, contentType: "text/plain" });
    });
    const target = new URL(origin);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
    expect(target.protocol).toBe("http:");
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (["data:", "blob:"].includes(url.protocol) || url.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const fixture = await distributionRoleFixture(page.request, origin);
    const token = fixture.creatorSession;
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    const identity = await page.request.get(`${origin}/api/v1/operator-identity`);
    expect(identity.status()).toBe(200);
    expect((await identity.json()).isTest).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    const libraryReady = page.waitForResponse((response) =>
      response.url().startsWith(`${contentApi}?offset=0`),
    );
    await page.goto(`${origin}/distribution`);
    await page.getByRole("button", { name: "Master library", exact: true }).click();
    expect((await libraryReady).status()).toBe(200);
    await page.getByRole("button", { name: "Upload raw master", exact: true }).click();
    const title = `Synthetic editorial fixture ${randomUUID().slice(0, 8)}`;
    await page.locator('input[name="title"]').fill(title);
    await page.locator('select[name="language"]').selectOption("en");
    await page.locator('select[name="category"]').selectOption("other");
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "synthetic-silence.wav", mimeType: "audio/wav", buffer: silentWav() });
    const createdPromise = page.waitForResponse(
      (response) => response.url() === contentApi && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Upload master and continue", exact: true }).click();
    const createdResponse = await createdPromise;
    expect(createdResponse.status()).toBe(201);
    const content = (await createdResponse.json()).content;
    const contentId = content.id as string;
    const reviewerContext = await browser.newContext({ serviceWorkers: "block" });
    await reviewerContext.addCookies([
      {
        name: "ds_session",
        value: fixture.reviewerSession,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await reviewerContext.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["data:", "blob:"].includes(url.protocol) || url.origin === origin
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    const reviewerPage = await reviewerContext.newPage();
    const reviewerPanel = reviewerPage
      .locator("details")
      .filter({ has: reviewerPage.locator("summary").filter({ hasText: /^Editorial review$/ }) });
    async function refreshEditorial(target: typeof page) {
      const summary = target.locator("summary").filter({ hasText: /^Editorial review$/ });
      await summary.click();
      const loaded = target.waitForResponse(
        (response) =>
          response.url() === `${editorialApi}/${contentId}` &&
          response.request().method() === "GET",
      );
      await summary.click();
      expect((await loaded).status()).toBe(200);
    }
    try {
      await page
        .locator("summary")
        .filter({ hasText: /^Editorial review$/ })
        .click();
      const panel = page
        .locator("details")
        .filter({ has: page.locator("summary").filter({ hasText: /^Editorial review$/ }) });
      await expect(panel.getByRole("heading", { name: "Transcripts", exact: true })).toBeVisible();
      await expect(panel.getByLabel("Source duration (seconds)", { exact: true })).toHaveValue("4");
      await panel.getByLabel("End (seconds)", { exact: true }).fill("1");
      await panel
        .getByRole("textbox", { name: "Transcript text", exact: true })
        .fill("Synthetic fixture sentence one.");
      await panel.getByRole("button", { name: "Add segment", exact: true }).click();
      await panel.getByLabel("End (seconds)", { exact: true }).nth(1).fill("2");
      await panel
        .getByRole("textbox", { name: "Transcript text", exact: true })
        .nth(1)
        .fill("Synthetic fixture sentence two.");
      const importedPromise = page.waitForResponse(
        (response) => response.url() === `${editorialApi}/${contentId}/transcript`,
      );
      await panel.getByRole("button", { name: "Save transcript", exact: true }).click();
      const importedResponse = await importedPromise;
      expect(importedResponse.status()).toBe(201);
      const transcript = (await importedResponse.json()).transcript;
      expect(transcript.review).toBeNull();
      expect(transcript.provenance.provider).toBe("manual");
      const transcripts = panel.getByRole("region", { name: "Transcripts", exact: true });
      await expect(transcripts.getByRole("button", { name: "Approve", exact: true })).toHaveCount(
        0,
      );
      await reviewerPage.goto(`${origin}/distribution`);
      await reviewerPage.getByRole("button", { name: "Master library", exact: true }).click();
      await reviewerPage
        .getByRole("button")
        .filter({ has: reviewerPage.getByText(title, { exact: true }) })
        .click();
      await reviewerPage
        .locator("summary")
        .filter({ hasText: /^Editorial review$/ })
        .click();
      const reviewedPromise = reviewerPage.waitForResponse(
        (response) => response.url() === `${editorialApi}/${transcript.id}/review`,
      );
      await reviewerPanel
        .getByRole("region", { name: "Transcripts", exact: true })
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      const reviewedResponse = await reviewedPromise;
      expect(reviewedResponse.status()).toBe(200);
      const reviewed = (await reviewedResponse.json()).transcript;
      expect(reviewed.review.decision).toBe("APPROVED");
      expect(reviewed.review.reviewerId).toBe(fixture.reviewerId);
      expect(reviewed.review.reviewerId).not.toBe(fixture.creatorId);
      await refreshEditorial(page);
      const quotes = panel.getByRole("region", { name: "Exact quotes", exact: true });
      await quotes.getByRole("combobox", { name: "To segment", exact: true }).selectOption("1");
      const quotedPromise = page.waitForResponse(
        (response) => response.url() === `${editorialApi}/${transcript.id}/quote`,
      );
      await quotes.getByRole("button", { name: "Create quote", exact: true }).click();
      const quotedResponse = await quotedPromise;
      expect(quotedResponse.status()).toBe(201);
      const quote = (await quotedResponse.json()).quote;
      expect(quote.text).toBe("Synthetic fixture sentence one. Synthetic fixture sentence two.");
      expect(quote.review).toBeNull();
      await refreshEditorial(reviewerPage);
      const quoteReviewPromise = reviewerPage.waitForResponse(
        (response) => response.url() === `${editorialApi}/${quote.id}/review-quote`,
      );
      await reviewerPanel
        .getByRole("region", { name: "Exact quotes", exact: true })
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      expect((await quoteReviewPromise).status()).toBe(200);
      await refreshEditorial(page);
      await expect(quotes.locator("article")).toContainText("Approved");
      const approvalRead = await page.request.get(`${editorialApi}/${contentId}`);
      expect((await approvalRead.json()).quoteEligibility[quote.id]).toEqual({ allowed: true });
      await quotes.getByRole("button", { name: "Play context", exact: true }).click();
      const player = panel.locator("audio");
      await expect
        .poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime))
        .toBeGreaterThan(0);
      await expect
        .poll(() => player.evaluate((element: HTMLAudioElement) => element.paused), {
          timeout: 7000,
        })
        .toBe(true);
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width + 1,
        );
        const small = await panel
          .locator("button:visible, input:visible, select:visible, summary:visible")
          .evaluateAll(
            (elements) =>
              elements.filter((element) => element.getBoundingClientRect().height < 43).length,
          );
        expect(small, `editorial touch targets at ${width}px`).toBe(0);
        await page.screenshot({
          path: testInfo.outputPath(`editorial-${width}.png`),
          fullPage: true,
        });
      }
      await transcripts
        .getByRole("textbox", { name: "Reviewed text", exact: true })
        .first()
        .fill("Synthetic fixture sentence one!");
      await expect(transcripts.getByRole("button", { name: "Approve", exact: true })).toHaveCount(
        0,
      );
      await expect(transcripts.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
      const correctedPromise = page.waitForResponse(
        (response) => response.url() === `${editorialApi}/${transcript.id}/correct`,
      );
      await transcripts.getByRole("button", { name: "Save corrections", exact: true }).click();
      const correctedResponse = await correctedPromise;
      expect(correctedResponse.status()).toBe(201);
      const corrected = (await correctedResponse.json()).transcript;
      expect(corrected.parentVersionId).toBe(transcript.id);
      expect(corrected.review).toBeNull();
      expect(corrected.segments[0].originalText).toBe("Synthetic fixture sentence one.");
      await expect(quotes.locator("article")).toContainText("The source changed.");
      await expect(
        quotes.locator("article").getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
      const invalidationRead = await page.request.get(`${editorialApi}/${contentId}`);
      const history = await invalidationRead.json();
      expect(history.quotes[0].review.decision).toBe("APPROVED");
      expect(history.quoteEligibility[quote.id]).toEqual({
        allowed: false,
        reason: "TRANSCRIPT_SUPERSEDED",
      });
      const blocked = await reviewerPage.request.post(`${editorialApi}/${quote.id}/review-quote`, {
        headers: { origin },
        data: { expectedRevision: history.quotes[0].revision, decision: "APPROVED" },
      });
      expect(blocked.status()).toBe(409);
      await page.screenshot({ path: testInfo.outputPath("editorial-history.png"), fullPage: true });
    } finally {
      await reviewerPage.request
        .post(`${contentApi}/${contentId}/withdraw`, {
          headers: { origin },
          data: { expectedRevision: content.revision },
          timeout: 10000,
        })
        .catch(() => undefined);
      await reviewerContext.close();
    }
  });
});
