import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { distributionFixtureSession } from "./distribution-session";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const enabled =
  process.env.DISTRIBUTION_E2E_ENABLED === "true" &&
  Boolean(process.env.DISTRIBUTION_E2E_PACKAGE_FIXTURE);
test.describe("DL full-package local browser acceptance", () => {
  test.skip(!enabled, "Explicit isolated local synthetic package fixture required.");
  test("reviews actual media, tests access, approves exact package and restores the full canonical route", async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120000);
    expect(["localhost", "127.0.0.1"]).toContain(new URL(origin).hostname);
    const fixturePath = process.env.DISTRIBUTION_E2E_PACKAGE_FIXTURE;
    if (!fixturePath) throw Error("LOCAL_FIXTURE_REQUIRED");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const session = await distributionFixtureSession(page.request, origin);
    await context.addCookies([
      { name: "ds_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === origin || ["data:", "blob:"].includes(u.protocol)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    await page.goto(`${origin}/distribution`);
    await page
      .getByRole("navigation", { name: "Distribution Hub", exact: true })
      .getByRole("button", { name: "Campaigns", exact: true })
      .click();
    await page
      .getByRole("button")
      .filter({
        has: page.getByRole("heading", {
          name: fixture.campaignName ?? "Synthetic full-package acceptance",
          exact: true,
        }),
      })
      .click();
    const review = page.getByRole("region", { name: "Full activation review", exact: true });
    await expect(review).toContainText("Synthetic QA preview only");
    await expect(review.getByRole("link", { name: "Open exact destination" })).toHaveAttribute(
      "href",
      fixture.canonicalPath,
    );
    await expect
      .poll(() =>
        review.locator("video").evaluate((node) => ({ w: node.videoWidth, h: node.videoHeight })),
      )
      .toEqual({ w: 1920, h: 1080 });
    await review.locator("video").evaluate(async (video) => {
      video.muted = true;
      await video.play();
      video.pause();
    });
    const section = review.locator("..");
    await expect(section.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    const tested = page.waitForResponse((r) =>
      r.url().endsWith(`/activations/${fixture.activationId}/validate-destination`),
    );
    await section.getByRole("button", { name: "Test Destination", exact: true }).click();
    expect((await tested).status()).toBe(200);
    await expect(review).toContainText("Sign-in required; exact destination restored");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      await review.screenshot({ path: info.outputPath(`full-package-${width}.png`) });
    }
    const approved = page.waitForResponse((r) =>
      r.url().endsWith(`/activations/${fixture.activationId}/approve`),
    );
    await section.getByRole("button", { name: "Approve", exact: true }).click();
    const approval = await approved;
    expect(approval.status()).toBe(200);
    expect((await approval.json()).activation.approvalPackageSha256).toMatch(/^[0-9a-f]{64}$/);
    const token = fixture.token as string;
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`${origin}/s/${token}`, {
            headers: { Accept: "application/json" },
          });
          return r.status() === 200 ? (await r.json()).destination : `status:${r.status()}`;
        },
        { timeout: 20000 },
      )
      .toBe(fixture.canonicalPath);
    const resolved = await page.request.get(`${origin}/s/${token}`, {
      headers: { Accept: "application/json" },
    });
    const data = await resolved.json();
    expect(data.requiresIdentity).toBe(true);
    expect(data.attributionId).toMatch(/^[0-9a-f-]{36}$/);
    const event = {
      version: 1,
      id: randomUUID(),
      name: "content_landing_viewed",
      occurredAt: new Date().toISOString(),
      roomId: fixture.canonicalPath.split("/").at(-1),
      attributionId: data.attributionId,
    };
    await expect
      .poll(
        async () =>
          (
            await page.request.post(`${origin}/api/v1/content/events`, {
              headers: { origin },
              data: event,
            })
          ).status(),
        { timeout: 15000 },
      )
      .toBe(200);
    const browser = context.browser();
    if (!browser) throw Error("BROWSER_REQUIRED");
    const anonymous = await browser.newContext();
    try {
      const signedOut = await anonymous.request.get(`${origin}/s/${token}`, { maxRedirects: 0 });
      expect(signedOut.status()).toBe(303);
      expect(signedOut.headers().location).toBe(`${origin}/login`);
      const cookies = await anonymous.cookies();
      expect(cookies.some((c) => c.name === "sgs_content_attribution" && c.httpOnly)).toBe(true);
    } finally {
      await anonymous.close();
    }
    const authenticated = await page.request.get(`${origin}/s/${token}`, { maxRedirects: 0 });
    expect(authenticated.status()).toBe(303);
    expect(authenticated.headers().location).toBe(`${origin}${fixture.canonicalPath}`);
  });
});
