import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { distributionFixtureSession } from "./distribution-session";
const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
test.describe("R6 local analytics acceptance", () => {
  test.skip(!enabled, "Explicit local fixture configuration required.");
  test("consent-scoped imports, outcome reconciliation, suppression and provider timestamps", async ({
    page,
    context,
  }, testInfo) => {
    const token = await distributionFixtureSession(page.request, origin);
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["data:", "blob:"].includes(url.protocol))
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const headers = { authorization: `Bearer ${token}` };
    const post = (path: string, data: unknown) =>
      page.request.post(`${origin}/distribution/api/${path}`, { headers, data });
    const response = await post("outreach/campaign", {
      name: `Synthetic analytics ${randomUUID().slice(0, 8)}`,
      program: "Local analytics fixture",
      goal: "Verify synthetic participation",
      outcomes: ["PRACTICE_COMPLETED"],
      startsAt: "2026-01-01T00:00:00Z",
      endsAt: "2027-01-01T00:00:00Z",
      budgetMicros: 0,
    });
    expect(response.status()).toBe(201);
    const campaign = (await response.json()).campaign;
    expect(
      (
        await post(`outreach/campaign/${campaign.id}/approve`, {
          expectedRevision: campaign.revision,
        })
      ).status(),
    ).toBe(200);
    await page.goto(`${origin}/distribution/analytics`);
    await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
    await expect(page.getByLabel("Campaign", { exact: true })).toBeVisible();
    if (await page.getByRole("button", { name: "Approve TEST policy" }).isVisible()) {
      await page.getByLabel("Approval reference UUID").fill(randomUUID());
      const approved = page.waitForResponse(
        (r) => r.url().endsWith("/distribution/api/analytics") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Approve TEST policy" }).click();
      expect((await approved).status()).toBe(200);
    }
    await page.getByLabel("Campaign", { exact: true }).selectOption(campaign.id);
    const now = Date.now();
    const events: Record<string, unknown>[] = [];
    let firstCompletion: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      const common = {
        version: 1,
        correlationId: randomUUID(),
        actorKey: i.toString(16).padStart(64, "0"),
        campaignId: campaign.id,
        activationId: null,
        contentId: null,
        ctaId: null,
        consentBasis: "explicit_consent",
        consentReceipt: randomUUID(),
        source: "operator_fixture",
      };
      events.push({
        ...common,
        id: randomUUID(),
        sourceEventId: randomUUID(),
        name: "tracked_link.opened",
        occurredAt: new Date(now - 120000).toISOString(),
        participationId: null,
      });
      const participationId = randomUUID();
      events.push({
        ...common,
        id: randomUUID(),
        sourceEventId: randomUUID(),
        name: "practice.started",
        occurredAt: new Date(now - 90000).toISOString(),
        participationId,
      });
      if (i < 10) {
        const complete = {
          ...common,
          id: randomUUID(),
          sourceEventId: randomUUID(),
          name: "practice.completed",
          occurredAt: new Date(now - 60000).toISOString(),
          participationId,
        };
        events.push(complete);
        firstCompletion ??= complete;
      }
    }
    const upload = async (command: unknown) => {
      const pending = page.waitForResponse(
        (r) => r.url().endsWith("/distribution/api/analytics") && r.request().method() === "POST",
      );
      await page.getByLabel("Import analytics command", { exact: true }).setInputFiles({
        name: "synthetic-analytics.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(command)),
      });
      const result = await pending;
      expect(result.status()).toBe(200);
      await expect(page.getByRole("button", { name: "Reconcile report" })).toBeEnabled();
      return result;
    };
    expect(await (await upload({ action: "ingest", events })).json()).toEqual({
      inserted: 50,
      duplicates: 0,
    });
    expect(await (await upload({ action: "ingest", events })).json()).toEqual({
      inserted: 0,
      duplicates: 50,
    });
    // Client clock skew must not change the server-defined reporting window.
    await page.clock.setFixedTime(new Date(now + 365 * 86400000));
    await page.getByRole("button", { name: "Reconcile report" }).click();
    const metric = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "Meaningful action rate", exact: true }) });
    await expect(metric).toContainText("50.0%");
    const dashboard = await page.request.get(`${origin}/distribution/api/analytics`, { headers });
    const snapshot = (await dashboard.json()).snapshots.find(
      (s: { campaign_id: string }) => s.campaign_id === campaign.id,
    );
    expect(snapshot.report).not.toHaveProperty("sourceEvents");
    expect(snapshot.report).not.toHaveProperty("unmatchedCompletions");
    await upload({
      action: "provider_snapshot",
      id: randomUUID(),
      campaignId: campaign.id,
      provider: "manual_fixture",
      metric: "views",
      value: 100,
      currency: null,
      definitionVersion: 1,
      observedAt: new Date(now - 60000).toISOString(),
    });
    await expect(page.getByText(/manual_fixture · views: 100/)).toBeVisible();
    if (!firstCompletion) throw new Error("Missing synthetic completion");
    await upload({
      action: "ingest",
      events: [
        {
          ...firstCompletion,
          id: randomUUID(),
          sourceEventId: randomUUID(),
          name: "practice.voided",
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    await expect(page.getByText("New source events are waiting for reconciliation.")).toBeVisible();
    await page.getByRole("button", { name: "Reconcile report" }).click();
    await expect(metric).toContainText("Private");
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      await page.screenshot({
        path: testInfo.outputPath(`analytics-${width}.png`),
        fullPage: true,
      });
    }
  });
});
