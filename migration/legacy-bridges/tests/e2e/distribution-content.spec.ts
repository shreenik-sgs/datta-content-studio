import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { expect, test } from "@playwright/test";
import { distributionRoleFixture } from "./distribution-role-fixture";

// Run through a dedicated config with no global warmup/sweep. The parent setup
// provisions distinct local TEST Content Coordinator and Admin identities.
// This spec creates/withdraws its own content only, through the real HTTP API.
const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const api = `${origin}/distribution/api/content`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=",
  "base64",
);

test.describe("DS-DIST-R1 local browser acceptance", () => {
  test.skip(!enabled, "Explicit local Distribution E2E setup is required.");
  test("DS-DIST-R1 create, review, export and withdraw across responsive sizes", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(120000);
    const url = new URL(origin);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.protocol).toBe("http:");
    expect(url.pathname).toBe("/");
    // Browser resources remain on the local origin, including the real core
    // identity bridge and the Hub proxy; no public platform is exercised.
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (["data:", "blob:"].includes(target.protocol) || target.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const actors = await distributionRoleFixture(page.request, origin);
    const switchActor = async (session: string) => {
      await context.addCookies([
        { name: "ds_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
      await page.goto(`${origin}/distribution`);
    };
    await switchActor(actors.creatorSession);
    const me = await page.request.get(`${origin}/api/v1/operator-identity`);
    expect(me.status()).toBe(200);
    const identity = (await me.json()) as { isTest: boolean; locale: string };
    expect(identity.isTest).toBe(true);
    expect(identity.locale).toBe("en");
    await page.goto(`${origin}/distribution`);
    await expect(
      page.getByRole("button", { name: "Upload raw master", exact: true }),
    ).toBeVisible();

    await switchActor(actors.reviewerSession);
    await expect(page.getByRole("button", { name: "Upload raw master", exact: true })).toHaveCount(
      0,
    );
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ["Source approvals", "Approved masters", "Master library"]) {
        const tab = page.getByRole("button", { name, exact: true });
        await tab.click();
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        const tabBox = await tab.boundingBox();
        expect(tabBox?.x, `${name} reachable at ${width}px`).toBeGreaterThanOrEqual(0);
        expect((tabBox?.x ?? 0) + (tabBox?.width ?? 0)).toBeLessThanOrEqual(width + 1);
      }
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(geometry.scroll, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(
        geometry.width + 1,
      );
      const undersized = await page
        .locator("main button:visible, main input:visible, main select:visible")
        .evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const box = element.getBoundingClientRect();
              return box.height < 43;
            }).length,
        );
      expect(undersized, `controls below 44px at ${width}px`).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`library-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await switchActor(actors.creatorSession);
    const title = `Distribution fixture ${randomUUID().slice(0, 8)}`;
    await page.getByRole("button", { name: "Upload raw master", exact: true }).click();
    for (const field of ["title", "language", "category"]) {
      const box = await page.locator(`[name="${field}"]`).boundingBox();
      expect(box?.height, `create ${field} touch target`).toBeGreaterThanOrEqual(43);
    }
    await page.locator('input[name="title"]').fill(title);
    await page.locator('select[name="language"]').selectOption("en");
    await page.locator('select[name="category"]').selectOption("sacred_flute");
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "source.png", mimeType: "image/png", buffer: png });
    const createdResponse = page.waitForResponse(
      (response) => response.url() === api && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Upload master and continue", exact: true }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const first = (await created.json()).content as { id: string; revision: number };
    const contentId = first.id;
    let revision = first.revision;
    try {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.locator(".preview img")).toBeVisible();
      const range = await page.request.get(`${api}/${contentId}/media`, {
        headers: { range: "bytes=0-7" },
      });
      expect(range.status()).toBe(206);
      expect(await range.body()).toEqual(png.subarray(0, 8));

      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(geometry.scroll, `detail overflow at ${width}px`).toBeLessThanOrEqual(
          geometry.width + 1,
        );
        await page.screenshot({ path: testInfo.outputPath(`detail-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      for (const field of [
        "owner",
        "authorization",
        "territories",
        "privacy",
        "release",
        "expiry",
      ]) {
        const element = page.locator(`[name="${field}"]`);
        if (await element.count()) {
          const box = await element.boundingBox();
          expect(box?.height, `rights ${field} touch target`).toBeGreaterThanOrEqual(43);
        }
      }
      await page.locator('input[name="owner"]').fill("Local fixture owner");
      await page.locator('textarea[name="authorization"]').fill("Local test authorization");
      await page.locator('input[name="territories"]').fill("WORLDWIDE");
      await page.locator('select[name="privacy"]').selectOption("PUBLIC");
      await page.getByLabel("Manual export package", { exact: true }).check();
      const rightsSaved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/${contentId}/rights`) && response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save rights", exact: true }).click();
      const rightsResponse = await rightsSaved;
      expect(rightsResponse.status()).toBe(200);
      revision = (await rightsResponse.json()).content.revision;
      await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
      expect(
        (
          await page.request.post(`${api}/${contentId}/approve`, {
            headers: { origin },
            data: { expectedRevision: revision },
          })
        ).status(),
      ).toBe(403);
      await switchActor(actors.reviewerSession);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      await page
        .getByRole("button")
        .filter({ has: page.getByText(title, { exact: true }) })
        .click();
      await expect(page.locator('input[name="owner"]')).toBeDisabled();
      const approved = page.waitForResponse((response) =>
        response.url().endsWith(`/${contentId}/approve`),
      );
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      const approvalResponse = await approved;
      expect(approvalResponse.status()).toBe(200);
      const approvedContent = (await approvalResponse.json()).content;
      revision = approvedContent.revision;
      expect(approvedContent.approval.reviewerId).toBe(actors.reviewerId);
      expect(approvedContent.approval.reviewerId).not.toBe(actors.creatorId);
      await page.locator('input[name="territory"]').fill("IN");
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Manual export", exact: true }).click();
      const download = await downloaded;
      const masterStem = `SGS_m${contentId}_source-v${approvedContent.currentVersion.number}`;
      expect(download.suggestedFilename()).toBe(`${masterStem}.tar`);
      const path = await download.path();
      expect(path).not.toBeNull();
      const archive = await readFile(path ?? "");
      const entries = new Map<string, Buffer>();
      for (let offset = 0; offset + 512 <= archive.length; ) {
        const name = archive
          .subarray(offset, offset + 100)
          .toString()
          .replaceAll("\0", "");
        if (!name) break;
        const size = Number.parseInt(
          archive
            .subarray(offset + 124, offset + 136)
            .toString()
            .replaceAll("\0", "")
            .trim(),
          8,
        );
        entries.set(name, archive.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      expect([...entries.keys()].sort()).toEqual([
        `${masterStem}.png`,
        `${masterStem}_manifest.json`,
      ]);
      expect(entries.get(`${masterStem}.png`)).toEqual(png);
      const manifest = JSON.parse(entries.get(`${masterStem}_manifest.json`)?.toString() ?? "null");
      expect(manifest.content.currentVersion.sha256).toBe(
        createHash("sha256").update(png).digest("hex"),
      );
      expect(manifest.content.revision).toBe(revision);
      expect(manifest.content.state).toBe("APPROVED");

      const stale = await page.request.post(`${api}/${contentId}/approve`, {
        headers: { origin },
        data: { expectedRevision: 1 },
      });
      expect(stale.status()).toBe(409);
      const foreign = await page.request.post(`${api}/${contentId}/withdraw`, {
        headers: { origin: "https://untrusted.example.test" },
        data: { expectedRevision: revision },
      });
      expect(foreign.status()).toBe(403);
      const stillCurrent = await page.request.get(api);
      expect(
        (await stillCurrent.json()).items.find((item: { id: string }) => item.id === contentId)
          .state,
      ).toBe("APPROVED");

      await page.getByRole("button", { name: "Withdraw", exact: true }).first().click();
      const withdrawn = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/${contentId}/withdraw`) && response.status() === 200,
      );
      await page.getByRole("alert").getByRole("button", { name: "Withdraw", exact: true }).click();
      const withdrawResponse = await withdrawn;
      revision = (await withdrawResponse.json()).content.revision;
      await expect(page.locator(".preview")).toContainText("Withdrawn");
      expect((await page.request.get(`${api}/${contentId}/media`)).status()).toBe(409);
      const stopped = await page.request.post(`${api}/${contentId}/export`, {
        headers: { origin },
        data: { expectedRevision: revision, channel: "manual_export", territory: "IN" },
      });
      expect(stopped.status()).toBe(409);
      await page.screenshot({ path: testInfo.outputPath("withdrawn-mobile.png"), fullPage: true });
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      const masterCard = page.getByRole("button").filter({
        has: page.getByRole("heading", { name: title, exact: true }),
      });
      await expect(page.getByLabel("Show master files")).toHaveValue("active");
      await expect(masterCard).toHaveCount(0);
      await page.getByLabel("Show master files").selectOption("withdrawn");
      await expect(masterCard).toBeVisible();
      await expect(masterCard).toContainText("Master: Withdrawn");
    } finally {
      // Only our own fixture content is retired; no accounts or prior content
      // are removed. A failed gate leaves its artifact available for diagnosis.
      const current = await page.request.get(api);
      if (current.ok()) {
        const item = (await current.json()).items.find(
          (value: { id: string }) => value.id === contentId,
        );
        if (item && item.state !== "WITHDRAWN")
          await page.request.post(`${api}/${contentId}/withdraw`, {
            headers: { origin, authorization: `Bearer ${actors.reviewerSession}` },
            data: { expectedRevision: item.revision },
          });
      }
    }
  });

  test("DS-DIST-R1 edits, stale selection and immutable source versions require fresh review", async ({
    page,
    context,
  }) => {
    const actors = await distributionRoleFixture(page.request, origin);
    const token = actors.creatorSession;
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (["data:", "blob:"].includes(target.protocol) || target.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const title = `Version fixture ${randomUUID().slice(0, 8)}`;
    const created = await page.request.post(api, {
      headers: { origin },
      multipart: {
        title,
        language: "en",
        category: "sacred_flute",
        file: { name: "original.png", mimeType: "image/png", buffer: png },
      },
    });
    expect(created.status()).toBe(201);
    let current = (await created.json()).content;
    const id = current.id as string;
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    const rights = {
      owner: "Local fixture owner",
      authorizationBasis: "Local version test",
      territories: ["WORLDWIDE"],
      channels: ["manual_export"],
      privacyClass: "PUBLIC",
      releaseAt: null,
      expiresAt: null,
    };
    const command = async (action: string, body: object) =>
      page.request.post(`${api}/${id}/${action}`, {
        headers: {
          origin,
          ...(["approve", "export", "withdraw"].includes(action)
            ? { authorization: `Bearer ${actors.reviewerSession}` }
            : {}),
        },
        data: { expectedRevision: current.revision, ...body },
      });
    const saveMetadata = async (name: string, status = 200) => {
      await page.locator(".editor-details summary").click();
      const form = page
        .locator(".editor-details form")
        .filter({ has: page.locator('input[name="title"]') });
      await form.locator('input[name="title"]').fill(name);
      const response = page.waitForResponse(
        (value) => value.url().endsWith(`/${id}/metadata`) && value.request().method() === "POST",
      );
      await form.getByRole("button", { name: "Save", exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(status);
      return result;
    };
    try {
      const attested = await command("rights", { rights });
      expect(attested.status()).toBe(200);
      current = (await attested.json()).content;
      const approved = await command("approve", {});
      expect(approved.status()).toBe(200);
      current = (await approved.json()).content;
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      await page.getByRole("button", { name: new RegExp(title) }).click();
      const renamed = `${title} reviewed`;
      current = (await (await saveMetadata(renamed)).json()).content;
      expect(current).toMatchObject({ title: renamed, state: "RIGHTS_CLEARED", approval: null });
      await expect(page.getByRole("heading", { name: renamed, exact: true })).toBeVisible();
      expect(
        (await command("export", { channel: "manual_export", territory: "IN" })).status(),
      ).toBe(409);

      // Another editor wins before this screen saves. A 409 must reload the
      // selected record rather than leave the operator trapped on stale data.
      const concurrentTitle = `${title} concurrent`;
      const changed = await command("metadata", {
        title: concurrentTitle,
        language: "en",
        category: "sacred_flute",
      });
      expect(changed.status()).toBe(200);
      current = (await changed.json()).content;
      await saveMetadata(`${title} losing edit`, 409);
      await expect(page.getByRole("heading", { name: concurrentTitle, exact: true })).toBeVisible();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("This content changed");
      const finalTitle = `${title} current`;
      current = (await (await saveMetadata(finalTitle)).json()).content;
      await expect(page.getByRole("heading", { name: finalTitle, exact: true })).toBeVisible();
      const reapproved = await command("approve", {});
      expect(reapproved.status()).toBe(200);
      current = (await reapproved.json()).content;
      expect(current.state).toBe("APPROVED");
      expect(current.approval.reviewerId).toBe(actors.reviewerId);
      expect(current.approval.reviewerId).not.toBe(actors.creatorId);
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(finalTitle);
      await page
        .getByRole("button")
        .filter({ has: page.getByText(finalTitle, { exact: true }) })
        .click();

      const sourceBase64 = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("CANVAS_UNAVAILABLE");
        drawing.fillStyle = "#a82b5a";
        drawing.fillRect(0, 0, 2, 2);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      const nextBytes = Buffer.from(sourceBase64 ?? "", "base64");
      await page.locator(".editor-details summary").click();
      const sourceForm = page
        .locator(".editor-details form")
        .filter({ has: page.locator('input[type="file"]') });
      await sourceForm
        .locator('input[type="file"]')
        .setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: nextBytes });
      const replaced = page.waitForResponse(
        (value) => value.url().endsWith(`/${id}/version`) && value.request().method() === "POST",
      );
      await sourceForm.getByRole("button", { name: "Save", exact: true }).click();
      const replacedResponse = await replaced;
      expect(replacedResponse.status()).toBe(201);
      current = (await replacedResponse.json()).content;
      expect(current).toMatchObject({
        state: "DRAFT",
        rights: null,
        approval: null,
        currentVersion: {
          number: 2,
          originalName: "replacement.png",
          sha256: createHash("sha256").update(nextBytes).digest("hex"),
        },
      });
      await expect(page.locator(".preview-meta")).toContainText("Version 2");
      expect(await (await page.request.get(`${api}/${id}/media`)).body()).toEqual(nextBytes);
      expect((await command("approve", {})).status()).toBe(409);
      expect(
        (await command("export", { channel: "manual_export", territory: "IN" })).status(),
      ).toBe(409);
      const history = await page.request.get(`${api}/${id}/versions`);
      expect(history.status()).toBe(200);
      const versions = (await history.json()).versions;
      expect(versions.map((value: { number: number }) => value.number).sort()).toEqual([1, 2]);
      expect(versions.find((value: { number: number }) => value.number === 1).sha256).toBe(
        createHash("sha256").update(png).digest("hex"),
      );

      // Verify only this fixture's two immutable private blobs in the isolated
      // local DB. Browser DTOs intentionally never disclose their storage keys.
      const assetRoot = process.env.DISTRIBUTION_ASSET_ROOT ?? "";
      expect(isAbsolute(assetRoot)).toBe(true);
      const assetDirectory = await lstat(assetRoot);
      expect(assetDirectory.isDirectory() && !assetDirectory.isSymbolicLink()).toBe(true);
      expect(assetDirectory.mode & 0o077).toBe(0);
      expect(await realpath(assetRoot)).toBe(assetRoot);
      const dockerHost =
        process.env.DOCKER_HOST ||
        execFileSync(
          "docker",
          [
            "context",
            "inspect",
            execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim(),
            "--format",
            "{{.Endpoints.docker.Host}}",
          ],
          { encoding: "utf8" },
        ).trim();
      expect(dockerHost.startsWith("unix://")).toBe(true);
      const rows = execFileSync(
        "docker",
        [
          "exec",
          "-i",
          "satsang-postgres",
          "psql",
          "-U",
          "satsang",
          "-d",
          process.env.DISTRIBUTION_E2E_HUB_DATABASE ?? "distribution_hub_local",
          "-tAq",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        {
          input: `SELECT json_agg(json_build_object('number',number,'key',storage_key)) FROM distribution.content_version WHERE master_id='${id}' AND is_test=true;`,
          encoding: "utf8",
        },
      );
      for (const version of JSON.parse(rows) as { number: number; key: string }[]) {
        expect(version.key).toMatch(/^distribution\/masters\/[a-f0-9-]{36}$/);
        const bytes = await readFile(`${process.env.DISTRIBUTION_ASSET_ROOT}/${version.key}`);
        expect(bytes).toEqual(version.number === 1 ? png : nextBytes);
      }
      await expect(page.locator('input[name="owner"]')).toHaveValue("");
      await page.locator('input[name="owner"]').fill(rights.owner);
      await page.locator('textarea[name="authorization"]').fill(rights.authorizationBasis);
      await page.locator('input[name="territories"]').fill("WORLDWIDE");
      await page.locator('select[name="privacy"]').selectOption("PUBLIC");
      await page.locator('input[name="rightsChannel"][value="manual_export"]').check();
      const reaffirmed = page.waitForResponse(
        (value) => value.url().endsWith(`/${id}/rights`) && value.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save rights", exact: true }).click();
      current = (await (await reaffirmed).json()).content;
      expect(
        (await command("export", { channel: "manual_export", territory: "IN" })).status(),
      ).toBe(409);
      const reviewed = await command("approve", {});
      expect(reviewed.status()).toBe(200);
      current = (await reviewed.json()).content;
      expect(current.approval.reviewerId).toBe(actors.reviewerId);
      const released = await command("export", { channel: "manual_export", territory: "IN" });
      expect(released.status()).toBe(200);
      expect((await released.body()).includes(nextBytes)).toBe(true);
    } finally {
      const detail = await page.request.get(`${api}/${id}/detail`);
      if (detail.ok()) {
        current = (await detail.json()).content;
        if (current.state !== "WITHDRAWN") await command("withdraw", {});
      }
    }
  });
});
