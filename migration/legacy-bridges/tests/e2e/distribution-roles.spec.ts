import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type BrowserContext, expect, test } from "@playwright/test";

const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const fixturePath = process.env.CIRCLES_E2E_FIXTURE_FILE;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=",
  "base64",
);

test("Content Coordinator creates; separate Admin approves and exports", async ({
  browser,
}, info) => {
  test.skip(
    process.env.DISTRIBUTION_E2E_ENABLED !== "true" || !fixturePath,
    "Local TEST role fixtures required",
  );
  expect(new URL(origin).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const fixture = JSON.parse(await readFile(fixturePath as string, "utf8"));
  const contexts: BrowserContext[] = [];
  const errors: string[] = [];
  const api = `${origin}/distribution/api/content`;
  async function actor(session: string) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "block",
    });
    contexts.push(context);
    await context.addCookies([
      { name: "ds_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin || ["blob:", "data:"].includes(url.protocol)
        ? route.continue()
        : route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const identity = await page.request.get(`${origin}/api/v1/operator-identity`);
    expect(identity.status()).toBe(200);
    expect((await identity.json()).isTest).toBe(true);
    await page.goto(`${origin}/distribution`);
    return page;
  }
  try {
    const creator = await actor(fixture.contentCoordinatorSession);
    await expect(
      creator.getByRole("button", { name: "Upload raw master", exact: true }),
    ).toBeVisible();
    await expect(
      creator.getByRole("button", { name: "Source approvals", exact: true }),
    ).toHaveCount(0);
    await expect(
      creator.getByRole("button", { name: "Approved masters", exact: true }),
    ).toHaveCount(0);
    const title = `Coordinator role QA ${randomUUID().slice(0, 8)}`;
    await creator.getByRole("button", { name: "Upload raw master", exact: true }).click();
    await creator.locator('input[name="title"]').fill(title);
    await creator.locator('select[name="language"]').selectOption("en");
    await creator
      .locator('input[type="file"]')
      .setInputFiles({ name: "synthetic-local-qa.png", mimeType: "image/png", buffer: png });
    const createdPromise = creator.waitForResponse(
      (response) => response.url() === api && response.request().method() === "POST",
    );
    await creator.getByRole("button", { name: "Upload master and continue", exact: true }).click();
    const createdResponse = await createdPromise;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()).content;
    await expect(creator.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await creator.locator('input[name="owner"]').fill("SGS Ashrama — synthetic local QA");
    await creator
      .locator('textarea[name="authorization"]')
      .fill(
        "Synthetic role verification asset. Local testing only; no social publication authorized.",
      );
    await creator.locator('input[name="territories"]').fill("WORLDWIDE");
    await creator.locator('select[name="privacy"]').selectOption("PUBLIC");
    await creator.getByLabel("Manual export package", { exact: true }).check();
    const rightsPromise = creator.waitForResponse(
      (response) =>
        response.url().endsWith(`/${created.id}/rights`) && response.request().method() === "POST",
    );
    await creator.getByRole("button", { name: "Save rights", exact: true }).click();
    const rightsResponse = await rightsPromise;
    expect(rightsResponse.status(), await rightsResponse.text()).toBe(200);
    const ready = (await rightsResponse.json()).content;
    await expect(creator.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    const refused = await creator.request.post(`${api}/${created.id}/approve`, {
      headers: { Origin: origin },
      data: { expectedRevision: ready.revision },
    });
    expect(refused.status(), await refused.text()).toBe(403);

    const admin = await actor(fixture.adminSession);
    await expect(admin.getByRole("button", { name: "Upload raw master", exact: true })).toHaveCount(
      0,
    );
    await expect(
      admin.getByRole("button", { name: "Source approvals", exact: true }),
    ).toBeVisible();
    await admin.getByRole("button", { name: "Source approvals", exact: true }).click();
    await admin
      .getByRole("button")
      .filter({ has: admin.getByText(title, { exact: true }) })
      .click();
    await expect(admin.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(admin.locator('input[name="owner"]')).toBeDisabled();
    for (const [role, page] of [
      ["creator", creator],
      ["admin", admin],
    ] as const) {
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width + 1,
        );
        await page.screenshot({
          path: info.outputPath(`hub-${role}-${width}.png`),
          fullPage: true,
        });
      }
    }
    const approvedPromise = admin.waitForResponse((response) =>
      response.url().endsWith(`/${created.id}/approve`),
    );
    await admin.getByRole("button", { name: "Approve", exact: true }).focus();
    await admin.keyboard.press("Enter");
    const approvedResponse = await approvedPromise;
    expect(approvedResponse.status(), await approvedResponse.text()).toBe(200);
    const approved = (await approvedResponse.json()).content;
    expect(approved.approval.reviewerId).toBe(fixture.adminId);
    expect(approved.approval.reviewerId).not.toBe(fixture.contentCoordinatorId);
    await admin.locator('input[name="territory"]').fill("US");
    const downloaded = admin.waitForEvent("download");
    await admin.getByRole("button", { name: "Manual export", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe(
      `SGS_m${created.id}_source-v${approved.currentVersion.number}.tar`,
    );
    const creatorExport = await creator.request.post(`${api}/${created.id}/export`, {
      headers: { Origin: origin },
      data: { expectedRevision: approved.revision, channel: "manual_export", territory: "US" },
    });
    expect(creatorExport.status()).toBe(403);
    expect(errors).toEqual([]);
    await info.attach("content-role-receipt", {
      body: JSON.stringify({
        sourceId: created.id,
        creatorId: fixture.contentCoordinatorId,
        reviewerId: fixture.adminId,
        widths: [320, 390, 1440],
        keyboardApproval: true,
        localExport: true,
        externalNetworkBlocked: true,
        socialPublished: false,
      }),
      contentType: "application/json",
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
