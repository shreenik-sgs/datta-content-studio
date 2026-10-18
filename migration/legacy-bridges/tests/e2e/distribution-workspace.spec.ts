import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { distributionRoleFixture } from "./distribution-role-fixture";

const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const packageId = process.env.DISTRIBUTION_WORKSPACE_PACKAGE_ID;

test.describe("Master to channel workspace", () => {
  test.skip(
    process.env.DISTRIBUTION_E2E_ENABLED !== "true",
    "Explicit isolated TEST stack required.",
  );
  test.beforeEach(async ({ context }) => {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["blob:", "data:"].includes(url.protocol))
        await route.continue();
      else await route.abort("blockedbyclient");
    });
  });

  test("both roles retain every core tab across responsive workspace and master screens", async ({
    page,
    context,
  }, info) => {
    const fixture = await distributionRoleFixture(page.request, origin);
    for (const [role, token] of [
      ["coordinator", fixture.creatorSession],
      ["admin", fixture.reviewerSession],
    ]) {
      await context.addCookies([
        { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
      await page.goto(`${origin}/distribution`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Channel workspace" }),
      ).toBeVisible();
      await expect(page.locator('.core-bottom-navigation a[aria-current="page"]')).toHaveText(
        "Content",
      );
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const links = [...document.querySelectorAll(".core-bottom-navigation a")];
              return (
                links.length > 2 &&
                links.every((link) => {
                  const rect = link.getBoundingClientRect();
                  return (
                    rect.left >= 0 &&
                    rect.right <= innerWidth &&
                    rect.top >= 0 &&
                    rect.bottom <= innerHeight &&
                    rect.width >= 43
                  );
                })
              );
            }),
          )
          .toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width + 1,
        );
      }
      if (role === "coordinator") {
        const upload = page.getByRole("button", { name: "Upload raw master", exact: true });
        await upload.focus();
        await page.keyboard.press("Enter");
        await expect(
          page.getByRole("heading", { level: 1, name: "Upload raw master" }),
        ).toBeFocused();
        await expect(page.locator('input[type="file"]')).toBeVisible();
        await expect(page.locator(".core-bottom-navigation")).toBeVisible();
        await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
        await page.getByRole("button", { name: "Choose existing master", exact: true }).click();
      } else {
        await expect(
          page.getByRole("button", { name: "Upload raw master", exact: true }),
        ).toHaveCount(0);
        await expect(page.getByLabel("Package queue")).toHaveValue("IN_REVIEW");
        await page.getByRole("button", { name: "Master library", exact: true }).click();
      }
      await expect(page.getByLabel("Show master files")).toHaveValue("active");
      await expect(
        page.locator(".content-card .badge").filter({ hasText: "Withdrawn" }),
      ).toHaveCount(0);
      const history = page.waitForResponse((r) => r.url().includes("archive=withdrawn") && r.ok());
      await page.getByLabel("Show master files").selectOption("withdrawn");
      expect(
        (await (await history).json()).items.every(
          (item: { state: string }) => item.state === "WITHDRAWN",
        ),
      ).toBe(true);
      await expect(page.locator(".core-bottom-navigation")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`${role}-navigation.png`) });
      await page.locator('.core-bottom-navigation a[href$="/profile"]').focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/profile/);
    }
  });

  test("a master groups its files in a channel table with truthful revision history and keyboard previews", async ({
    page,
    context,
  }, info) => {
    test.skip(!packageId, "A saved TEST package with generated files is required.");
    const fixture = await distributionRoleFixture(page.request, origin);
    await context.addCookies([
      {
        name: "ds_session",
        value: fixture.creatorSession,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const result = await page.request.get(`${origin}/distribution/api/studio/${packageId}`);
    expect(result.ok()).toBe(true);
    const { package: pkg } = await result.json();
    expect(pkg.isTest).toBe(true);
    await page.goto(`${origin}/distribution`);
    const workspace = page.getByRole("region", { name: "Intelligent content", exact: true });
    const master = workspace
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: pkg.source.title, exact: true }) });
    await expect(master).toHaveCount(1);
    await master.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "One master, every channel output" }),
    ).toBeVisible();
    await expect(page.locator(".lineage-table tbody tr")).toHaveCount(pkg.outputs.length);
    for (const label of [
      "Filename",
      "Channel",
      "Type / language",
      "Length",
      "Current revision",
      "Generated",
      "Package updated",
      "Lifecycle status",
      "Review comments",
    ]) {
      await expect(
        page.locator(".lineage-table").getByRole("columnheader", { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(page.locator(".selected-output-preview")).toHaveCount(0);
    const first = pkg.outputs.find((output: { asset: unknown }) => output.asset);
    await page
      .getByRole("button", { name: `Preview ${first.asset.filename}`, exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`#output-preview-${first.id}`)).toBeFocused();
    await expect(page.locator(".selected-output-preview")).toHaveCount(1);
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.locator(".studio-history > summary").click();
    await expect(page.locator(".studio-history-version").first()).toContainText(
      `Version ${pkg.revision}`,
    );
    await expect(page.locator(".studio-history-version time").first()).toHaveAttribute(
      "datetime",
      /T/,
    );
    await page.locator(".studio-history-version").first().click();
    await expect(
      page.getByRole("region", { name: `Files in version ${pkg.revision}` }),
    ).toBeVisible();
    expect(await page.locator(".studio-history-snapshot:visible a[download]").count()).toBe(0);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width + 1,
      );
      await page.screenshot({ path: info.outputPath(`lineage-${width}.png`), fullPage: true });
    }
  });

  test("one audio upload opens its own queued package and permission step", async ({
    page,
    context,
  }) => {
    const fixture = await distributionRoleFixture(page.request, origin);
    await context.addCookies([
      {
        name: "ds_session",
        value: fixture.creatorSession,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    // One second of synthetic PCM silence; no external content or AI call.
    const wav = Buffer.alloc(32044);
    wav.write("RIFF");
    wav.writeUInt32LE(32036, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32000, 40);
    let masterId: string | undefined;
    try {
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Upload raw master", exact: true }).click();
      await page
        .locator('input[name="title"]')
        .fill(`Workspace synthetic upload ${randomUUID().slice(0, 8)}`);
      await page.locator('select[name="language"]').selectOption("en");
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "synthetic-silence.wav", mimeType: "audio/wav", buffer: wav });
      const saved = page.waitForResponse(
        (r) => r.url() === `${origin}/distribution/api/content` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Upload master and continue", exact: true }).click();
      const response = await saved;
      expect(response.status()).toBe(201);
      const body = await response.json();
      masterId = body.content.id;
      expect(body.studioPackage.source.masterId).toBe(masterId);
      expect(body.studioPackage.request.channels).toHaveLength(12);
      await expect(
        page.getByText("Next: confirm this master's permissions", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`Master ${masterId} · Source version`, { exact: false }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Review master permissions", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Master file and permissions", exact: true }),
      ).toBeFocused();
      await expect(page.locator(".core-bottom-navigation")).toBeVisible();
    } finally {
      if (masterId) {
        const headers = { origin, authorization: `Bearer ${fixture.reviewerSession}` };
        const current = await page.request.get(
          `${origin}/distribution/api/content/${masterId}/detail`,
          { headers },
        );
        const content = (await current.json()).content;
        const withdrawn = await page.request.post(
          `${origin}/distribution/api/content/${masterId}/withdraw`,
          { headers, data: { expectedRevision: content.revision } },
        );
        expect(withdrawn.ok()).toBe(true);
      }
    }
  });
});
