import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { distributionRoleFixture } from "./distribution-role-fixture";

const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const contentApi = `${origin}/distribution/api/content`;
const renderApi = `${origin}/distribution/api/renders`;
const editorialApi = `${origin}/distribution/api/editorial`;

// Two seconds of generated solid color and silence; no sacred recording or
// quotation, external resource, paid provider or public publication is used.
async function syntheticVideo(folder: string): Promise<Buffer> {
  const path = join(folder, "synthetic.mp4");
  execFileSync(
    "/opt/homebrew/bin/ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xa82b5a:s=320x180:r=30",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads:v",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      path,
    ],
    { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return readFile(path);
}
function tarFiles(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const name = bytes
      .subarray(offset, offset + 100)
      .toString("ascii")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(bytes.subarray(offset + 124, offset + 136).toString("ascii"), 8);
    expect(Number.isSafeInteger(size)).toBe(true);
    expect(offset + 512 + size).toBeLessThanOrEqual(bytes.length);
    files.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test.describe("DS-DIST-R3 local worker and browser acceptance", () => {
  test.skip(!enabled, "Explicit local Distribution E2E setup and worker are required.");
  test("DS-DIST-R3 queue, render, preview, review and exact export reject a changed source", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(150000);
    page.setDefaultTimeout(10000);
    const fixture = await distributionRoleFixture(page.request, origin);
    const token = fixture.reviewerSession;
    const authorToken = fixture.creatorSession;
    await context.addCookies([
      { name: "ds_session", value: authorToken, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (["blob:", "data:"].includes(target.protocol) || target.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "distribution-render-browser-"));
    let contentId: string | undefined;
    try {
      const bytes = await syntheticVideo(temporary);
      const title = `Synthetic render fixture ${randomUUID().slice(0, 8)}`;
      const created = await page.request.post(contentApi, {
        headers: { origin },
        multipart: {
          title,
          language: "en",
          category: "other",
          file: { name: "synthetic.mp4", mimeType: "video/mp4", buffer: bytes },
        },
      });
      expect(created.status()).toBe(201);
      let content = (await created.json()).content;
      contentId = content.id;
      const command = async (action: string, data: object) =>
        page.request.post(`${contentApi}/${contentId}/${action}`, {
          headers: {
            origin,
            ...(action === "approve" ? { authorization: `Bearer ${token}` } : {}),
          },
          data: { expectedRevision: content.revision, ...data },
        });
      const rights = await command("rights", {
        rights: {
          owner: "Local synthetic fixture",
          territories: ["WORLDWIDE"],
          channels: ["manual_export"],
          authorizationBasis: "Generated solid color and silence",
          privacyClass: "PUBLIC",
          releaseAt: null,
          expiresAt: null,
        },
      });
      expect(rights.status()).toBe(200);
      content = (await rights.json()).content;
      const approval = await command("approve", {});
      expect(approval.status()).toBe(200);
      content = (await approval.json()).content;
      const imported = await page.request.post(`${editorialApi}/${contentId}/transcript`, {
        headers: { origin },
        data: {
          expectedSourceVersionId: content.currentVersion.id,
          language: "en",
          durationMs: 2000,
          segments: [
            {
              id: "synthetic-segment",
              startMs: 0,
              endMs: 1000,
              originalText: "Synthetic render fixture.",
              displayText: "Synthetic render fixture.",
            },
          ],
        },
      });
      expect(imported.status()).toBe(201);
      const transcript = (await imported.json()).transcript;
      const reviewed = await page.request.post(`${editorialApi}/${transcript.id}/review`, {
        headers: { origin, authorization: `Bearer ${token}` },
        data: { expectedRevision: transcript.revision, decision: "APPROVED" },
      });
      expect(reviewed.status()).toBe(200);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      await page.getByRole("button", { name: new RegExp(title) }).click();
      const panel = page
        .locator("details")
        .filter({ has: page.locator("summary").filter({ hasText: /^Versions for sharing$/ }) });
      await panel.locator("summary").click();
      await expect(panel.locator('select[name="transcript"]')).toBeVisible();
      await panel.locator('select[name="transcript"]').selectOption(transcript.id);
      await panel.locator('select[name="aspect"]').selectOption("16:9");
      await panel.getByLabel("Destination platform").selectOption("instagram");
      await panel.locator('input[name="end"]').fill("1");
      await panel.locator('select[name="captions"]').selectOption("approved_transcript");
      await panel.locator('input[name="territory"]').fill("IN");
      console.info("R3: ready to enqueue through browser");
      const queued = page.waitForResponse(
        (response) => response.url() === renderApi && response.request().method() === "POST",
      );
      await panel.getByRole("button", { name: "Create version", exact: true }).click();
      console.info("R3: create click returned");
      const queuedResponse = await queued;
      console.info("R3: queue response received");
      expect(queuedResponse.status()).toBe(201);
      // Inspect committed state through a fresh request. Chromium's CDP body
      // retrieval can stay pending for this proxied fetch after its 201 status.
      const queuedState = await page.request.get(`${renderApi}?masterId=${contentId}`, {
        timeout: 10000,
      });
      expect(queuedState.status()).toBe(200);
      const queuedJobs = (await queuedState.json()).jobs;
      expect(queuedJobs).toHaveLength(1);
      const job = queuedJobs[0];
      console.info("R3: queue response decoded");
      expect(job.recipe.endMs - job.recipe.startMs).toBe(1000);
      expect(job.recipe.fit).toBe("contain");
      expect(job.recipe.placement).toBe("instagram");
      expect(job).not.toHaveProperty("leaseToken");
      // The durable worker owns execution. This browser never calls claim or succeed.
      let completed:
        | {
            artifacts: {
              artifact: {
                id: string;
                output: {
                  video: { sha256: string; filename: string };
                  captions: { filename: string };
                  manifest: { filename: string };
                };
              };
              eligibility: { allowed: boolean; reason?: string };
            }[];
          }
        | undefined;
      await expect
        .poll(
          async () => {
            const status = await page.request.get(`${renderApi}?masterId=${contentId}`, {
              timeout: 10000,
            });
            expect(status.status()).toBe(200);
            const body = await status.json();
            completed = body;
            const current = body.jobs.find((value: { id: string }) => value.id === job.id);
            return current.status === "FAILED" || current.status === "STALE"
              ? `${current.status}:${current.lastError}`
              : current.status;
          },
          { timeout: 90000, intervals: [500, 1000, 2000] },
        )
        .toBe("SUCCEEDED");
      const item = completed?.artifacts[0];
      expect(item).toBeDefined();
      const artifactId = item?.artifact.id as string;
      expect(item?.eligibility).toEqual({ allowed: false, reason: "ARTIFACT_NOT_APPROVED" });
      console.info("R3: worker completed; checking private media");
      const media = await page.request.get(`${renderApi}/${artifactId}/media`, {
        headers: { range: "bytes=0-15" },
      });
      expect(media.status()).toBe(206);
      expect((await media.body()).subarray(4, 8).toString("ascii")).toBe("ftyp");
      console.info("R3: partial media checked; checking captions");
      const captions = await page.request.get(`${renderApi}/${artifactId}/captions`);
      expect(captions.status()).toBe(200);
      expect(await captions.text()).toContain("Synthetic render fixture.");
      console.info("R3: captions checked; checking unapproved export");
      expect(
        (
          await page.request.get(`${renderApi}/${artifactId}/export`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status(),
      ).toBe(409);
      console.info("R3: unapproved export refused; checking browser playback");
      const card = panel.locator(".variant-card");
      await expect(card).toContainText("Intended channel: instagram");
      await expect(card.locator(".filename")).toContainText(contentId as string);
      await expect(card.locator(".filename")).toContainText("_instagram_");
      await expect(card.locator("video")).toBeVisible();
      await expect
        .poll(() =>
          card.locator("video").evaluate((element: HTMLVideoElement) => element.readyState),
        )
        .toBeGreaterThanOrEqual(2);
      console.info("R3: video metadata loaded; bringing player into view");
      await card.locator("video").scrollIntoViewIfNeeded();
      const playback = await card.locator("video").evaluate(async (element: HTMLVideoElement) => {
        element.muted = true;
        const result = await Promise.race([
          element.play().then(
            () => "playing",
            (error: Error) => error.name,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("play-pending"), 5000)),
        ]);
        return {
          result,
          readyState: element.readyState,
          networkState: element.networkState,
          error: element.error?.code ?? null,
          paused: element.paused,
          currentTime: element.currentTime,
        };
      });
      console.info("R3: playback result", playback);
      expect(playback, "A visible muted preview should begin playing").toMatchObject({
        result: "playing",
        error: null,
      });
      await expect
        .poll(() =>
          card.locator("video").evaluate((element: HTMLVideoElement) => element.currentTime),
        )
        .toBeGreaterThan(0);
      await card.locator("video").evaluate((element: HTMLVideoElement) => element.pause());
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(layout.scroll, `variant overflow at ${width}px`).toBeLessThanOrEqual(
          layout.width + 1,
        );
        await panel.screenshot({ path: testInfo.outputPath(`variant-${width}.png`) });
      }
      // A different person signs in to review the exact generated media.
      await context.addCookies([
        { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      await page.getByRole("button", { name: new RegExp(title) }).click();
      await panel.locator("summary").click();
      await expect(panel.getByRole("button", { name: "Create version", exact: true })).toHaveCount(
        0,
      );
      const approved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/${artifactId}/review`) &&
          response.request().method() === "POST",
      );
      await card.getByRole("button", { name: "Approve", exact: true }).click();
      expect((await approved).status()).toBe(200);
      const downloadReady = page.waitForEvent("download");
      await card.getByRole("link", { name: "Manual export", exact: true }).click();
      const download = await downloadReady;
      const videoName = item?.artifact.output.video.filename as string;
      const captionName = item?.artifact.output.captions.filename as string;
      const manifestName = item?.artifact.output.manifest.filename as string;
      expect(videoName).toContain(contentId);
      expect(videoName).toContain("_instagram_video_en_16x9_");
      expect(download.suggestedFilename()).toBe(videoName.replace(/\.mp4$/, ".tar"));
      const downloadPath = await download.path();
      expect(downloadPath).not.toBeNull();
      const files = tarFiles(await readFile(downloadPath as string));
      expect([...files.keys()].sort()).toEqual([captionName, manifestName, videoName].sort());
      const manifest = JSON.parse(files.get(manifestName)?.toString("utf8") ?? "null");
      expect(manifest.artifact.approval.decision).toBe("APPROVED");
      expect(manifest.masterId).toBe(contentId);
      expect(manifest.sourceVersionId).toBe(content.currentVersion.id);
      expect(manifest.intendedChannel).toBe("instagram");
      expect(
        createHash("sha256")
          .update(files.get(videoName) ?? "")
          .digest("hex"),
      ).toBe(item?.artifact.output.video.sha256);
      expect(files.get(captionName)?.toString()).toContain("Synthetic render fixture.");
      expect(JSON.stringify(manifest)).not.toContain("storageKey");
      const replacement = await page.request.post(`${contentApi}/${contentId}/version`, {
        headers: { origin, authorization: `Bearer ${authorToken}` },
        multipart: {
          expectedRevision: String(content.revision),
          file: { name: "new-source-version.mp4", mimeType: "video/mp4", buffer: bytes },
        },
      });
      expect(replacement.status()).toBe(201);
      expect((await page.request.get(`${renderApi}/${artifactId}/media`)).status()).toBe(409);
      expect((await page.request.get(`${renderApi}/${artifactId}/export`)).status()).toBe(409);
      await expect(card.locator("video")).toHaveCount(0, { timeout: 10000 });
      await expect(card).toContainText("The source changed");
    } finally {
      // A browser/test timeout must not replace the original failure with a
      // request-context disposal error during cleanup.
      try {
        if (contentId) {
          const detail = await fetch(`${contentApi}/${contentId}/detail`, {
            headers: { cookie: `ds_session=${token}` },
            signal: AbortSignal.timeout(5000),
          });
          if (detail.ok()) {
            const current = (await detail.json()).content;
            if (current.state !== "WITHDRAWN") {
              const withdrawn = await fetch(`${contentApi}/${contentId}/withdraw`, {
                method: "POST",
                headers: {
                  cookie: `ds_session=${token}`,
                  origin,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ expectedRevision: current.revision }),
                signal: AbortSignal.timeout(5000),
              });
              if (!withdrawn.ok)
                testInfo.annotations.push({
                  type: "cleanup",
                  description: "Synthetic fixture withdrawal needs a local retry.",
                });
            }
          }
        }
      } catch {
        testInfo.annotations.push({
          type: "cleanup",
          description: "Synthetic fixture cleanup needs a local retry.",
        });
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
