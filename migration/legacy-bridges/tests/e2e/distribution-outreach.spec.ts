import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { distributionRoleFixture } from "./distribution-role-fixture";
import { distributionFixtureSession } from "./distribution-session";
const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const api = `${origin}/distribution/api/outreach`;
test.describe("DS-DIST-R4 local authoring acceptance", () => {
  test.skip(!enabled, "Explicit local Distribution E2E setup required.");
  test("DS-DIST-R4 campaign and invitation revisions, human review and terminal stop", async ({
    page,
    context,
    browser,
  }, testInfo) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(15000);
    const url = new URL(origin);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.protocol).toBe("http:");
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (["data:", "blob:"].includes(target.protocol) || target.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const token = await distributionFixtureSession(page.request, origin);
    const fixture = await distributionRoleFixture(page.request, origin);
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    const library = page.waitForResponse((response) =>
      response.url().startsWith(`${origin}/distribution/api/content?offset=0`),
    );
    await page.goto(`${origin}/distribution`);
    expect((await library).status()).toBe(200);
    const list = page.waitForResponse((response) => response.url().startsWith(`${api}?offset=0`));
    await page
      .getByRole("navigation", { name: "Distribution Hub", exact: true })
      .getByRole("button", { name: "Campaigns", exact: true })
      .click();
    expect((await list).status()).toBe(200);
    const panel = page.getByRole("region", { name: "Campaigns", exact: true });
    await panel.getByRole("button", { name: "Create campaign", exact: true }).click();
    const title = `Synthetic outreach ${randomUUID().slice(0, 8)}`;
    await panel.getByRole("textbox", { name: "Campaign name", exact: true }).fill(title);
    await panel
      .getByRole("textbox", { name: "Program", exact: true })
      .fill("Local synthetic programme");
    await panel
      .getByRole("textbox", { name: "Goal", exact: true })
      .fill("Exercise a local authoring review; no public dispatch.");
    await panel.locator('input[name="startsAt"]').fill("2026-09-29T15:00");
    await panel.locator('input[name="endsAt"]').fill("2026-10-30T15:00");
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      const tiny = await panel
        .locator("button:visible,input:visible,select:visible")
        .evaluateAll(
          (elements) =>
            elements.filter((element) => element.getBoundingClientRect().height < 43).length,
        );
      expect(tiny).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath(`campaign-form-${width}.png`),
        fullPage: true,
      });
    }
    const createdPromise = page.waitForResponse(
      (response) => response.url() === `${api}/campaign` && response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    const created = await createdPromise;
    expect(created.status()).toBe(201);
    let campaign = (await created.json()).campaign;
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
      const target = new URL(route.request().url());
      return ["data:", "blob:"].includes(target.protocol) || target.origin === origin
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    const reviewerPage = await reviewerContext.newPage();
    const authorIdentity = await page.request.get(`${origin}/api/v1/operator-identity`);
    expect((await authorIdentity.json()).id).not.toBe(fixture.reviewerId);
    async function openEntity(target: typeof page, kind: "campaign" | "cta", label: string) {
      await target.goto(`${origin}/distribution`);
      await target
        .getByRole("navigation", { name: "Distribution Hub", exact: true })
        .getByRole("button", { name: "Campaigns", exact: true })
        .click();
      const region = target.getByRole("region", { name: "Campaigns", exact: true });
      if (kind === "cta")
        await region.getByRole("button", { name: "Invitations", exact: true }).click();
      await region
        .getByRole("button")
        .filter({ has: target.getByRole("heading", { name: label, exact: true }) })
        .click();
      await expect(region.getByRole("heading", { name: label, exact: true })).toBeVisible();
      return region;
    }
    try {
      await expect(panel.getByRole("heading", { name: title, exact: true })).toBeVisible();
      const command = async (action: string, name: string) => {
        const actor = action === "approve" ? reviewerPage : page;
        const actionPanel =
          action === "approve" ? await openEntity(reviewerPage, "campaign", title) : panel;
        const pending = actor.waitForResponse(
          (response) => response.url() === `${api}/campaign/${campaign.id}/${action}`,
        );
        await actionPanel.getByRole("button", { name, exact: true }).click();
        const response = await pending;
        expect(response.status()).toBe(200);
        campaign = (await response.json()).campaign;
        if (action === "approve") {
          expect(campaign.approval.reviewerId).toBe(fixture.reviewerId);
          await openEntity(page, "campaign", title);
        }
      };
      const selfReview = await page.request.post(`${api}/campaign/${campaign.id}/approve`, {
        headers: { origin },
        data: { expectedRevision: campaign.revision },
      });
      expect(selfReview.status()).toBe(403);
      expect((await selfReview.json()).error).toBe("INDEPENDENT_REVIEW_REQUIRED");
      await command("approve", "Approve");
      expect(campaign.approval.revision).toBe(campaign.revision);
      await command("pause", "Pause");
      expect(campaign.status).toBe("PAUSED");
      expect(campaign.approval).toBeNull();
      await panel.getByRole("button", { name: "Revise for review", exact: true }).click();
      await panel
        .getByRole("textbox", { name: "Goal", exact: true })
        .fill("Revised synthetic goal");
      await command("edit", "Save");
      expect(campaign.status).toBe("DRAFT");
      expect(campaign.approval).toBeNull();
      await command("approve", "Approve");
      const stale = await reviewerPage.request.post(`${api}/campaign/${campaign.id}/approve`, {
        headers: { origin },
        data: { expectedRevision: 1 },
      });
      expect(stale.status()).toBe(409);
      await panel.getByRole("button", { name: "Stop", exact: true }).click();
      const stoppedPromise = page.waitForResponse(
        (response) => response.url() === `${api}/campaign/${campaign.id}/stop`,
      );
      await panel.getByRole("alert").getByRole("button", { name: "Stop", exact: true }).click();
      const stopped = await stoppedPromise;
      expect(stopped.status()).toBe(200);
      campaign = (await stopped.json()).campaign;
      expect(campaign.status).toBe("STOPPED");
      await expect(panel.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
      const history = await page.request.get(`${api}/campaign/${campaign.id}`);
      expect((await history.json()).history.map((item: { status: string }) => item.status)).toEqual(
        ["STOPPED", "APPROVED", "DRAFT", "PAUSED", "APPROVED", "DRAFT"],
      );
      await panel.getByRole("button", { name: "Invitations", exact: true }).click();
      await panel.getByRole("button", { name: "Create invitation", exact: true }).click();
      const invitationCopy = `Synthetic invitation ${randomUUID().slice(0, 8)}`;
      await panel.getByRole("textbox", { name: "Button text", exact: true }).fill(invitationCopy);
      await panel
        .getByRole("textbox", { name: "Destination", exact: true })
        .fill("/practice/flute-meditation");
      await panel
        .getByRole("textbox", { name: "Alternative destination", exact: true })
        .fill("/home");
      const refusedPromise = page.waitForResponse(
        (response) => response.url() === `${api}/cta` && response.request().method() === "POST",
      );
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      expect((await refusedPromise).status()).toBe(400);
      await expect(panel.getByRole("alert")).toBeVisible();
      await panel
        .getByRole("textbox", { name: "Alternative destination", exact: true })
        .fill("/practice/koti-parayana");
      const ctaPromise = page.waitForResponse(
        (response) => response.url() === `${api}/cta` && response.request().method() === "POST",
      );
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      const response = await ctaPromise;
      expect(response.status()).toBe(201);
      let cta = (await response.json()).cta;
      expect(cta.approval).toBeNull();
      const reviewPanel = await openEntity(reviewerPage, "cta", invitationCopy);
      const reviewedPromise = reviewerPage.waitForResponse(
        (response) => response.url() === `${api}/cta/${cta.id}/approve`,
      );
      await reviewPanel.getByRole("button", { name: "Approve", exact: true }).click();
      const reviewedResponse = await reviewedPromise;
      expect(reviewedResponse.status()).toBe(200);
      expect((await reviewedResponse.json()).cta.approval.reviewerId).toBe(fixture.reviewerId);
      await openEntity(page, "cta", invitationCopy);
      await panel.getByRole("button", { name: "Edit", exact: true }).click();
      await panel
        .getByRole("textbox", { name: "Button text", exact: true })
        .fill("Revised synthetic invitation");
      const editPromise = page.waitForResponse(
        (response) => response.url() === `${api}/cta/${cta.id}/edit`,
      );
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      const edited = await editPromise;
      expect(edited.status()).toBe(200);
      cta = (await edited.json()).cta;
      expect(cta.approval).toBeNull();
      expect(cta.revision).toBe(3);
      const ctaHistory = await page.request.get(`${api}/cta/${cta.id}`);
      expect(
        (await ctaHistory.json()).history.map((item: { revision: number }) => item.revision),
      ).toEqual([3, 2, 1]);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath("invitation-mobile.png"), fullPage: true });
    } finally {
      if (campaign.status !== "STOPPED")
        await page.request
          .post(`${api}/campaign/${campaign.id}/stop`, {
            headers: { origin },
            data: { expectedRevision: campaign.revision },
            timeout: 10000,
          })
          .catch(() => undefined);
      await reviewerContext.close();
    }
  });
});
