import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { distributionFixtureSession } from "./distribution-session";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
test.describe("V3.2 nurturing local browser acceptance", () => {
  test.skip(!enabled, "Explicit isolated local preview is required");
  test("optional preferences, personal goals, responsive journey and flag-off parity", async ({
    page,
    context,
  }, info) => {
    const connection = new URL(process.env.DATABASE_URL ?? "");
    expect(connection.hostname).toBe("localhost");
    expect(connection.port).toBe("5442");
    expect(connection.pathname).toMatch(/^\/nurturing_preview_/);
    page.setDefaultTimeout(15000);
    const db = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    const token = await distributionFixtureSession(page.request, origin);
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const flags = [
      "nurturing_home",
      "nurturing_onboarding",
      "personal_sankalpa",
      "sadhana_rhythm",
      "journey_offerings",
      "nurturing_recommendations",
    ];
    try {
      // SPT: validates the existing feature administration page.
      const administration = await page.request.get(`${origin}/admin/features`);
      expect(administration.status()).toBe(200);
      expect(await administration.text()).toContain("Participation measurement");
      await page.goto(`${origin}/home`);
      const card = page.getByRole("region", { name: "Today with Sri Swamiji", exact: true });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Personalize my home", exact: true }).click();
      await card.getByRole("button", { name: "Meditation", exact: true }).click();
      await expect
        .poll(async () => {
          const r = await page.request.get(`${origin}/api/v1/nurturing`);
          return (await r.json()).preferences.interests.includes("meditation");
        })
        .toBe(true);
      await card.getByRole("button", { name: "Skip for now", exact: true }).click();
      await card.getByRole("button", { name: "My goals and offerings", exact: true }).click();
      const begin = card.getByRole("button", { name: "Begin my Sankalpa", exact: true });
      if (await begin.isVisible()) await begin.click();
      await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(card.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width + 1,
        );
      }
      await page.screenshot({ path: info.outputPath("nurturing-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: info.outputPath("nurturing-phone.png"), fullPage: true });
      const denied = await page.request.post(`${origin}/api/v1/nurturing`, {
        headers: { Origin: "https://invalid.example.test" },
        data: { action: "dismiss", id: randomUUID() },
      });
      expect(denied.status()).toBe(403);
      await db.query("UPDATE feature_flags SET stage='OFF' WHERE key=ANY($1::text[])", [flags]);
      await expect
        .poll(async () => (await page.request.get(`${origin}/api/v1/nurturing`)).status(), {
          timeout: 10000,
        })
        .toBe(404);
      await page.reload();
      await expect(card).toHaveCount(0);
      await expect(page.getByText("A quiet daily practice · local example").first()).toBeVisible();
    } finally {
      await db.query("UPDATE feature_flags SET stage='TEST' WHERE key=ANY($1::text[])", [flags]);
      await db.end();
    }
  });
});
