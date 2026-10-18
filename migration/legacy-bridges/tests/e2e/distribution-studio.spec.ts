import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { STUDIO_CHANNELS, type StudioPackage } from "@satsang/distribution-domain";
import { distributionRoleFixture } from "./distribution-role-fixture";

const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const studioApi = `${origin}/distribution/api/studio`;
const sourceApi = `${origin}/distribution/api/content`;
async function syntheticVideo(folder: string) {
  const path = join(folder, "synthetic-studio.mp4");
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

test.describe("Intelligent content local role and package workflow", () => {
  test.skip(!enabled, "Requires the explicit local TEST Studio worker and role fixture.");
  test("one upload creates a complete branded package, independent review and idempotent test publication", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(300000);
    page.setDefaultTimeout(15000);
    const fixture = await distributionRoleFixture(page.request, origin);
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "sgs-studio-browser-"));
    let masterId: string | undefined;
    let packageId: string | undefined;
    const authorHeaders = { origin, authorization: `Bearer ${fixture.creatorSession}` };
    const adminHeaders = { origin, authorization: `Bearer ${fixture.reviewerSession}` };
    const title = `Studio synthetic workflow ${randomUUID().slice(0, 8)}`;
    const session = async (token: string) => {
      await context.addCookies([
        { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
      ]);
    };
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (["blob:", "data:"].includes(target.protocol) || target.origin === origin)
        await route.continue();
      else await route.abort("blockedbyclient");
    });
    const readPackage = async (): Promise<StudioPackage> => {
      const response = await page.request.get(`${studioApi}/${packageId}`, {
        headers: authorHeaders,
        timeout: 15000,
      });
      expect(response.status()).toBe(200);
      return (await response.json()).package;
    };
    const waitForDraft = async () => {
      await expect
        .poll(async () => (await readPackage()).status, {
          timeout: 100000,
          intervals: [1000, 2000],
        })
        .toBe("DRAFT");
      return readPackage();
    };
    const openPackage = async (token: string) => {
      await session(token);
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Work queue", exact: true }).click();
      const panel = page.getByRole("region", { name: "Intelligent content", exact: true });
      await panel.getByLabel("Package queue").selectOption("active");
      const packageButton = panel
        .getByRole("button")
        .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await packageButton.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByText(`Master ${masterId}`, { exact: false })).toBeVisible();
      await expect(
        panel.getByRole("heading", { name: title, exact: true, level: 2 }),
      ).toBeFocused();
      return panel;
    };
    try {
      await session(fixture.creatorSession);
      const uploaded = await page.request.post(sourceApi, {
        headers: authorHeaders,
        multipart: {
          title,
          language: "en",
          category: "other",
          file: {
            name: "synthetic-studio.mp4",
            mimeType: "video/mp4",
            buffer: await syntheticVideo(temporary),
          },
        },
      });
      expect(uploaded.status()).toBe(201);
      const upload = await uploaded.json();
      let master = upload.content;
      masterId = master.id;
      packageId = upload.studioPackage?.id;
      expect(packageId, "Audio/video upload must durably enqueue Studio generation").toBeTruthy();
      expect(upload.studioPackage.request.channels).toEqual([...STUDIO_CHANNELS]);
      const again = await page.request.post(studioApi, {
        headers: authorHeaders,
        data: {
          masterId,
          expectedSourceRevision: master.revision,
          request: upload.studioPackage.request,
        },
      });
      expect(again.status()).toBe(201);
      expect((await again.json()).package.id).toBe(packageId);
      const rights = await page.request.post(`${sourceApi}/${masterId}/rights`, {
        headers: authorHeaders,
        data: {
          expectedRevision: master.revision,
          rights: {
            owner: "Local synthetic fixture",
            territories: ["WORLDWIDE"],
            channels: [...STUDIO_CHANNELS, "manual_export"],
            authorizationBasis: "Generated solid colour and silence for local workflow testing.",
            privacyClass: "PUBLIC",
            releaseAt: null,
            expiresAt: null,
          },
        },
      });
      expect(rights.status()).toBe(200);
      master = (await rights.json()).content;
      const approved = await page.request.post(`${sourceApi}/${masterId}/approve`, {
        headers: adminHeaders,
        data: { expectedRevision: master.revision },
      });
      expect(approved.status()).toBe(200);
      master = (await approved.json()).content;
      const transcriptResponse = await page.request.post(
        `${origin}/distribution/api/editorial/${masterId}/transcript`,
        {
          headers: authorHeaders,
          data: {
            expectedSourceVersionId: master.currentVersion.id,
            language: "en",
            durationMs: 2000,
            segments: [
              {
                id: "first",
                startMs: 0,
                endMs: 1000,
                originalText: "Synthetic source for local workflow testing.",
                displayText: "Synthetic source for local workflow testing.",
              },
              {
                id: "second",
                startMs: 1000,
                endMs: 2000,
                originalText: "No devotional teaching is represented.",
                displayText: "No devotional teaching is represented.",
              },
            ],
          },
        },
      );
      expect(transcriptResponse.status()).toBe(201);
      const transcript = (await transcriptResponse.json()).transcript;
      expect(
        (
          await page.request.post(`${origin}/distribution/api/editorial/${transcript.id}/review`, {
            headers: adminHeaders,
            data: { expectedRevision: transcript.revision, decision: "APPROVED" },
          })
        ).status(),
      ).toBe(200);
      await expect
        .poll(async () => (await readPackage()).status, {
          timeout: 100000,
          intervals: [1000, 2000],
        })
        .not.toMatch(/^(QUEUED|GENERATING)$/);
      let value = await readPackage();
      expect(
        (
          await page.request.post(`${studioApi}/${packageId}/regenerate`, {
            headers: authorHeaders,
            data: { expectedRevision: value.revision },
          })
        ).status(),
      ).toBe(200);
      value = await waitForDraft();
      expect(new Set(value.outputs.map((output) => output.format))).toEqual(
        new Set(["short", "reel", "post", "blog"]),
      );
      expect(
        value.outputs.every((output) => output.asset && output.body.includes("SGS Datta Sannidhi")),
      ).toBe(true);
      expect(value.provenance?.transcript.provenance).toBe("APPROVED_TRANSCRIPT");
      let panel = await openPackage(fixture.creatorSession);
      await expect(panel.getByRole("button", { name: "Approve package", exact: true })).toHaveCount(
        0,
      );
      expect(
        (
          await page.request.post(`${studioApi}/${packageId}/review`, {
            headers: authorHeaders,
            data: {
              expectedRevision: value.revision,
              decision: "APPROVED",
              comment: "",
              confirmTranscript: true,
              confirmTeachingIntegrity: true,
            },
          })
        ).status(),
      ).toBe(403);
      await expect(panel.locator("video")).toHaveCount(0);
      const videos = value.outputs.filter((output) => output.asset?.mimeType === "video/mp4");
      expect(
        videos.length,
        "The generated package must include playable video files",
      ).toBeGreaterThan(0);
      await panel.getByLabel("Filter by channel", { exact: true }).selectOption("youtube");
      const youtubeOutputs = value.outputs.filter((output) => output.channel === "youtube");
      await expect(panel.locator(".lineage-table tbody tr")).toHaveCount(youtubeOutputs.length);
      await panel.getByLabel("Filter by channel", { exact: true }).selectOption("all");
      await expect(panel.locator(".lineage-table tbody tr")).toHaveCount(value.outputs.length);
      for (const output of videos) {
        const asset = output.asset;
        if (!asset) throw new Error("MISSING_VIDEO_ASSET");
        await panel.getByRole("button", { name: `Preview ${asset.filename}`, exact: true }).click();
        const preview = panel.locator(`#output-preview-${output.id}`);
        await expect(preview).toBeVisible();
        await expect(panel.locator(".selected-output-preview")).toHaveCount(1);
        const video = preview.locator("video");
        await expect(video).toBeVisible();
        await video.evaluate(async (element: HTMLVideoElement) => {
          element.muted = true;
          await element.play();
        });
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
          .toBeGreaterThanOrEqual(2);
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
          .toBeGreaterThan(0.1);
        await video.evaluate((element: HTMLVideoElement) => element.pause());
        await page.keyboard.press("Escape");
        await expect(
          panel.getByRole("dialog", { name: "Channel file preview", exact: true }),
        ).toHaveCount(0);
        await expect(
          panel.getByRole("button", { name: `Preview ${asset.filename}`, exact: true }),
        ).toBeFocused();
      }
      const imageOutput = value.outputs.find((output) =>
        output.asset?.mimeType.startsWith("image/"),
      );
      if (!imageOutput?.asset) throw new Error("MISSING_IMAGE_ASSET");
      await panel
        .getByRole("button", { name: `Preview ${imageOutput.asset.filename}`, exact: true })
        .click();
      const imagePreview = panel.locator(`#output-preview-${imageOutput.id}`);
      await expect(imagePreview).toBeVisible();
      await expect(panel.locator(".selected-output-preview")).toHaveCount(1);
      await expect(panel.locator("video")).toHaveCount(0);
      await expect
        .poll(() =>
          imagePreview.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth),
        )
        .toBeGreaterThan(0);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(geometry.scroll, `Studio overflow at ${width}px`).toBeLessThanOrEqual(
          geometry.width + 1,
        );
        await panel.screenshot({ path: testInfo.outputPath(`studio-creator-${width}.png`) });
      }
      await panel.getByRole("button", { name: "Close preview", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await panel
        .getByLabel("Note for Content Approver")
        .fill("Please review this synthetic package.");
      // Safari on macOS uses Option-Tab to include buttons when full keyboard access is off.
      await page.keyboard.press(testInfo.project.name === "webkit" ? "Alt+Tab" : "Tab");
      await expect(
        panel.getByRole("button", { name: "Submit package for review", exact: true }),
      ).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("studio-mobile-keyboard-submit.png") });
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await readPackage()).status).toBe("IN_REVIEW");
      panel = await openPackage(fixture.reviewerSession);
      await panel.getByRole("button", { name: "Request changes", exact: true }).click();
      await expect(panel.getByRole("alert")).toContainText("Explain the requested changes");
      await expect(
        panel.getByLabel("Review comments — required when requesting changes"),
      ).toBeFocused();
      await panel
        .getByLabel("Review comments — required when requesting changes")
        .fill("Use a clearer title for the Ashrama blog, preserving the synthetic source text.");
      await page.screenshot({ path: testInfo.outputPath("studio-mobile-admin-review.png") });
      await panel.getByRole("button", { name: "Request changes", exact: true }).click();
      await expect.poll(async () => (await readPackage()).status).toBe("CHANGES_REQUESTED");
      panel = await openPackage(fixture.creatorSession);
      await expect(panel.getByRole("region", { name: "Review discussion" })).toContainText(
        "Use a clearer title",
      );
      await panel.getByRole("button", { name: "Edit package text", exact: true }).click();
      const editForm = panel
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Save package revision", exact: true }) });
      const current = await readPackage();
      const blog = current.outputs.find((output) => output.channel === "website");
      const post = current.outputs.find((output) => output.channel === "x");
      expect(blog).toBeDefined();
      expect(post).toBeDefined();
      await editForm.locator(`[name="title-${blog?.id}"]`).fill("Reviewed synthetic source");
      await editForm.locator(`[name="title-${post?.id}"]`).fill("Reviewed synthetic post");
      await editForm
        .getByLabel("Response to reviewer")
        .fill("Updated the blog and post titles; source words remain intact.");
      await editForm.getByRole("button", { name: "Save package revision", exact: true }).click();
      await expect.poll(async () => (await readPackage()).status).toBe("DRAFT");
      await expect
        .poll(
          async () => (await readPackage()).outputs.find((output) => output.id === blog?.id)?.asset,
        )
        .toBeNull();
      await panel.getByRole("button", { name: "Regenerate with guidance", exact: true }).click();
      const regeneration = page.waitForResponse(
        (response) =>
          response.url() === `${studioApi}/${packageId}/regenerate` &&
          response.request().method() === "POST",
      );
      await panel.getByRole("button", { name: "Regenerate complete package", exact: true }).click();
      expect((await regeneration).status()).toBe(200);
      value = await waitForDraft();
      expect(value.outputs.find((output) => output.channel === "website")?.title).toBe(
        "Reviewed synthetic source",
      );
      expect(value.outputs.find((output) => output.channel === "website")?.asset).not.toBeNull();
      expect(value.outputs.find((output) => output.channel === "x")?.title).toBe(
        "Reviewed synthetic post",
      );
      expect(value.outputs.find((output) => output.channel === "x")?.asset?.mimeType).toBe(
        "image/png",
      );
      await panel
        .getByLabel("Note for Content Approver")
        .fill("The reviewed title is now in the regenerated blog file.");
      await panel.getByRole("button", { name: "Submit package for review", exact: true }).click();
      await expect.poll(async () => (await readPackage()).status).toBe("IN_REVIEW");
      panel = await openPackage(fixture.reviewerSession);
      await panel
        .getByLabel(
          "I checked source boundaries, context, attribution, captions and translations, and Ashrama branding for every included output.",
          { exact: true },
        )
        .check();
      await panel.getByRole("button", { name: "Approve package", exact: true }).click();
      await expect.poll(async () => (await readPackage()).status).toBe("APPROVED");
      value = await readPackage();
      await panel.getByRole("button", { name: "Run test publication", exact: true }).click();
      await expect
        .poll(
          async () => {
            const response = await page.request.get(`${studioApi}/${packageId}`, {
              headers: adminHeaders,
            });
            const result = await response.json();
            return (
              result.publications.length ===
                value.outputs.filter((output) => output.included).length &&
              result.publications.every(
                (publication: { status: string }) => publication.status === "SIMULATED",
              )
            );
          },
          { timeout: 60000, intervals: [1000, 2000] },
        )
        .toBe(true);
      const repeat = await page.request.post(`${studioApi}/${packageId}/publish`, {
        headers: adminHeaders,
        data: { expectedRevision: value.revision },
      });
      expect(repeat.status()).toBe(200);
      const publications = (await repeat.json()).publications;
      expect(
        new Set(publications.map((publication: { outputId: string }) => publication.outputId)).size,
      ).toBe(publications.length);
      expect(publications).toHaveLength(value.outputs.filter((output) => output.included).length);
      await expect(
        panel.getByText("Test completed — not posted", { exact: true }).first(),
      ).toBeVisible();
      await panel.screenshot({ path: testInfo.outputPath("studio-admin-test-results.png") });
      const discarded = value.outputs.find((output) => output.channel === "x");
      expect(discarded).toBeDefined();
      const discard = await page.request.post(`${studioApi}/${packageId}/discard`, {
        headers: adminHeaders,
        data: {
          expectedRevision: value.revision,
          outputId: discarded?.id,
          comment: "Discard this synthetic X output after the rehearsal.",
        },
      });
      expect(discard.status()).toBe(200);
      const revised = (await discard.json()).package;
      expect(revised.approval).toBeNull();
      expect(
        revised.outputs.find((output: { id: string }) => output.id === discarded?.id).included,
      ).toBe(false);
      expect(
        (
          await page.request.post(`${studioApi}/${packageId}/publish`, {
            headers: adminHeaders,
            data: { expectedRevision: revised.revision },
          })
        ).status(),
      ).toBe(409);
    } finally {
      try {
        if (packageId) {
          const value = await readPackage();
          if (value.status !== "DISCARDED")
            await page.request.post(`${studioApi}/${packageId}/discard`, {
              headers: adminHeaders,
              data: {
                expectedRevision: value.revision,
                comment: "Local synthetic acceptance cleanup.",
              },
            });
        }
        if (masterId) {
          const response = await page.request.get(`${sourceApi}/${masterId}/detail`, {
            headers: adminHeaders,
          });
          if (response.ok()) {
            const master = (await response.json()).content;
            if (master.state !== "WITHDRAWN")
              await page.request.post(`${sourceApi}/${masterId}/withdraw`, {
                headers: adminHeaders,
                data: { expectedRevision: master.revision },
              });
          }
        }
      } catch {
        testInfo.annotations.push({
          type: "cleanup",
          description: "Synthetic Studio fixture cleanup requires a local retry.",
        });
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
