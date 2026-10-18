import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const fixtureFile = process.env.GUIDANCE_E2E_FIXTURE_FILE;
test.describe("Content Guidance V1 local browser acceptance", () => {
  test.skip(
    process.env.DISTRIBUTION_E2E_ENABLED !== "true" || !fixtureFile,
    "Requires explicit isolated local guidance fixture",
  );
  test("DL01/09/10/13/14 canonical content, ordered curation, keyboard and responsive library", async ({
    page,
    context,
  }, info) => {
    test.setTimeout(180000);
    expect(new URL(origin).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    const fixture = JSON.parse(await readFile(fixtureFile as string, "utf8"));
    await context.addCookies([
      {
        name: "ds_session",
        value: fixture.authorSession,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const active = await page.request.get(`${origin}/api/v1/home/guidance/active`);
    expect(active.status()).toBe(200);
    const guidance = (await active.json()).collection;
    expect(guidance.items).toHaveLength(2);
    const detail = await page.request.get(`${origin}/api/v1/content/room/${fixture.sourceId}`);
    expect(detail.status()).toBe(200);
    const canonical = (await detail.json()).content;
    expect(canonical.kind).toBe("DISCOURSE");
    expect(canonical.durationSeconds).toBe(600);
    await page.goto(`${origin}/home`);
    await expect(page.locator("[data-content-home]")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Explore This Week’s Guidance by Dattaji", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Today with Dattaji", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("#weekly-guidance h3")).toHaveText(
      guidance.items.map((item: { title: string }) => item.title),
    );
    await expect(
      page.getByRole("button", { name: "Personalize my home", exact: true }),
    ).toHaveCount(0);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      await page.screenshot({
        path: info.outputPath(`guidance-home-${width}.png`),
        fullPage: true,
      });
    }
    const first = page.locator("#weekly-guidance a").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}/content/room/${fixture.sourceId}`);
    await expect(page.getByRole("heading", { name: canonical.title, exact: true })).toBeVisible();
    const next = await page.request.get(`${origin}/api/v1/content/room/${fixture.sourceId}/next`);
    expect((await next.json()).primary.href).toBe(`/content/room/${fixture.practiceRoomId}`);
    await page.getByRole("link", { name: "Finish and explore", exact: true }).click();
    const choices = page.getByRole("region", { name: "Continue your journey", exact: true });
    await expect(choices).toBeVisible();
    await expect(choices.getByRole("link")).toHaveCount(2);
    await expect(
      choices.getByRole("link", { name: "Begin the practice Dattaji described", exact: true }),
    ).toHaveAttribute("href", `/content/room/${fixture.practiceRoomId}`);
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("post-content.png"), fullPage: true });
    await choices.getByRole("link", { name: "Explore More", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/explore`);
    const search = page.getByRole("searchbox", { name: "Search the library", exact: true });
    await search.focus();
    await page.keyboard.type("Synthetic");
    await expect(search).toHaveValue("Synthetic");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "Category", exact: true })).toBeFocused();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      await page.screenshot({
        path: info.outputPath(`content-library-${width}.png`),
        fullPage: true,
      });
    }
    await page.goto(`${origin}/admin/weekly-guidance`);
    await expect(page.getByRole("heading", { name: "Weekly guidance", exact: true })).toBeVisible();
    const collection = page.getByRole("button").filter({ hasText: guidance.title }).first();
    await collection.click();
    for (const name of ["Web", "iOS", "Android"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.screenshot({
        path: info.outputPath(`guidance-admin-${name.toLowerCase()}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });
});

// Deliberately separate from visual capture; changes only the task-owned preview switches.
test("DL15 rollback and partial rollout preserve working legacy Home", async ({
  page,
  context,
}, info) => {
  test.skip(
    process.env.DISTRIBUTION_E2E_ENABLED !== "true" ||
      !fixtureFile ||
      process.env.GUIDANCE_E2E_ROLLBACK !== "1",
    "Requires explicit isolated preview rollback rehearsal",
  );
  const connection = new URL(process.env.DATABASE_URL ?? "");
  expect(connection.hostname).toBe("localhost");
  expect(connection.port).toBe("5442");
  expect(connection.pathname).toMatch(/^\/nurturing_preview_/);
  const fixture = JSON.parse(await readFile(fixtureFile as string, "utf8"));
  await context.addCookies([
    {
      name: "ds_session",
      value: fixture.authorSession,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const db = new Pool({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  const flags = [
    "today_with_dattaji",
    "weekly_dattaji_guidance",
    "weekly_guidance_admin",
    "explore_library",
    "universal_content_landing",
    "tracked_social_deep_links",
    "post_content_next_step",
  ];
  const original = await db.query(
    "SELECT key, stage FROM feature_flags WHERE key=ANY($1::text[])",
    [flags],
  );
  expect(original.rows).toHaveLength(7);
  try {
    // Prove the reader has observed ON before removing a dependency, avoiding a cache-only pass.
    await db.query("UPDATE feature_flags SET stage='TEST' WHERE key=ANY($1::text[])", [flags]);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/v1/practices`)).json()).contentExperience
            .layoutEnabled,
        { timeout: 15000 },
      )
      .toBe(true);
    await db.query("UPDATE feature_flags SET stage='OFF' WHERE key='universal_content_landing'");
    await expect
      .poll(
        async () =>
          (await page.request.get(`${origin}/api/v1/content/room/${fixture.sourceId}`)).status(),
        { timeout: 15000 },
      )
      .toBe(404);
    expect(
      (await (await page.request.get(`${origin}/api/v1/practices`)).json()).contentExperience
        .layoutEnabled,
    ).toBe(false);
    expect(
      (await (await page.request.get(`${origin}/api/v1/home/guidance/active`)).json()).enabled,
    ).toBe(false);
    expect((await page.request.get(`${origin}/api/v1/content/library`)).status()).toBe(404);
    await db.query("UPDATE feature_flags SET stage='OFF' WHERE key=ANY($1::text[])", [flags]);
    await expect
      .poll(async () => (await page.request.get(`${origin}/api/v1/content/library`)).status(), {
        timeout: 15000,
      })
      .toBe(404);
    await page.goto(`${origin}/home`);
    await expect(page.locator("[data-content-home]")).toHaveCount(0);
    await expect(page.locator('a[href^="/practice/"]').first()).toBeVisible();
    const legacyRoute = await page.locator('a[href^="/practice/"]').first().getAttribute("href");
    expect((await page.request.get(`${origin}${legacyRoute}`)).status()).toBe(200);
    for (const route of ["/explore", `/content/room/${fixture.sourceId}`, `/s/${"a".repeat(43)}`])
      expect((await page.request.get(`${origin}${route}`)).status(), route).toBe(404);
    expect(
      (await (await page.request.get(`${origin}/api/v1/home/guidance/active`)).json()).enabled,
    ).toBe(false);
    const disabledAdmin = await page.request.get(`${origin}/admin/weekly-guidance`);
    expect(disabledAdmin.status()).toBe(200);
    expect(await disabledAdmin.text()).toContain("Weekly guidance administration is switched off");
    expect((await page.request.get(`${origin}/api/v1/admin/weekly-guidance`)).status()).toBe(404);
    await page.screenshot({ path: info.outputPath("guidance-rollback-home.png"), fullPage: true });
  } finally {
    for (const flag of original.rows)
      await db.query("UPDATE feature_flags SET stage=$2 WHERE key=$1", [flag.key, flag.stage]);
    await db.end();
  }
});
