import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  INTEGRITY_CHECKS,
  type NativeAnalysis,
} from "../../packages/distribution-domain/src/native-intelligence";
import { distributionFixtureSession } from "./distribution-session";
const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
const fixturePath = process.env.CIRCLES_E2E_FIXTURE_FILE;
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

test.describe("V3.2 native teaching review", () => {
  test.skip(
    !enabled || !fixturePath,
    "Explicit local preview and separate role fixtures are required",
  );
  test("native evidence gates approved boundaries into Variant Studio", async ({
    page,
    context,
    browser,
  }, info) => {
    page.setDefaultTimeout(10000);
    const token = await distributionFixtureSession(page.request, origin);
    await context.addCookies([
      { name: "ds_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const reviewerIdentityResponse = await page.request.get(`${origin}/api/v1/operator-identity`);
    expect(reviewerIdentityResponse.status()).toBe(200);
    const reviewerIdentity = await reviewerIdentityResponse.json();
    expect(reviewerIdentity.isTest).toBe(true);
    expect(
      reviewerIdentity.roles.some((role: string) =>
        ["TECH_SUPER_ADMIN", "SUPER_ADMIN"].includes(role),
      ),
    ).toBe(true);
    expect(reviewerIdentity.roles).not.toContain("CONTENT_COORDINATOR");
    const fixture = JSON.parse(await readFile(fixturePath as string, "utf8"));
    const authorContext = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    await authorContext.addCookies([
      {
        name: "ds_session",
        value: fixture.contentCoordinatorSession,
        url: origin,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await authorContext.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const author = await authorContext.newPage();
    author.setDefaultTimeout(10000);
    const authorIdentityResponse = await author.request.get(`${origin}/api/v1/operator-identity`);
    expect(authorIdentityResponse.status()).toBe(200);
    const authorIdentity = await authorIdentityResponse.json();
    expect(authorIdentity.id).toBe(fixture.contentCoordinatorId);
    expect(authorIdentity.id).not.toBe(reviewerIdentity.id);
    expect(authorIdentity.isTest).toBe(true);
    expect(authorIdentity.roles).toContain("CONTENT_COORDINATOR");
    expect(authorIdentity.roles).not.toContain("SUPER_ADMIN");
    expect(authorIdentity.roles).not.toContain("TECH_SUPER_ADMIN");
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "native-review-browser-"));
    let contentId: string | undefined;
    try {
      const title = `Synthetic native review ${randomUUID().slice(0, 8)}`;
      const created = await author.request.post(`${origin}/distribution/api/content`, {
        headers: { origin },
        multipart: {
          title,
          language: "te",
          category: "other",
          file: {
            name: "synthetic.mp4",
            mimeType: "video/mp4",
            buffer: await syntheticVideo(temporary),
          },
        },
      });
      expect(created.status()).toBe(201);
      let content = (await created.json()).content;
      contentId = content.id;
      const rights = await author.request.post(
        `${origin}/distribution/api/content/${contentId}/rights`,
        {
          headers: { origin },
          data: {
            expectedRevision: content.revision,
            rights: {
              owner: "Local synthetic fixture",
              territories: ["WORLDWIDE"],
              channels: ["manual_export"],
              authorizationBasis: "Generated color and silence; synthetic test text only",
              privacyClass: "PUBLIC",
              releaseAt: null,
              expiresAt: null,
            },
          },
        },
      );
      expect(rights.status()).toBe(200);
      content = (await rights.json()).content;
      const refusedSourceApproval = await author.request.post(
        `${origin}/distribution/api/content/${contentId}/approve`,
        { headers: { origin }, data: { expectedRevision: content.revision } },
      );
      expect(refusedSourceApproval.status()).toBe(403);
      const approved = await page.request.post(
        `${origin}/distribution/api/content/${contentId}/approve`,
        { headers: { origin }, data: { expectedRevision: content.revision } },
      );
      expect(approved.status()).toBe(200);
      content = (await approved.json()).content;
      const imported = await author.request.post(
        `${origin}/distribution/api/editorial/${contentId}/transcript`,
        {
          headers: { origin },
          data: {
            expectedSourceVersionId: content.currentVersion.id,
            language: "te",
            durationMs: 2000,
            segments: [
              {
                id: "synthetic-segment",
                startMs: 0,
                endMs: 1000,
                originalText: "కృత్రిమ పరీక్ష మాత్రమే",
                displayText: "కృత్రిమ పరీక్ష మాత్రమే",
              },
            ],
          },
        },
      );
      expect(imported.status()).toBe(201);
      const transcript = (await imported.json()).transcript;
      const reviewed = await page.request.post(
        `${origin}/distribution/api/editorial/${transcript.id}/review`,
        {
          headers: { origin },
          data: { expectedRevision: transcript.revision, decision: "APPROVED" },
        },
      );
      expect(reviewed.status()).toBe(200);
      const analysis: NativeAnalysis = {
        schemaVersion: 1,
        transcriptVersionId: transcript.id,
        transcriptRevision: transcript.revision + 1,
        sourceSha256: transcript.sourceSha256,
        language: "te",
        glossaryVersionIds: [],
        annotations: [
          {
            segmentId: "synthetic-segment",
            confidence: 1,
            speakerId: "synthetic",
            speakerName: "Synthetic test speaker",
            languageSpans: [{ startMs: 0, endMs: 1000, language: "te" }],
            words: [],
            englishShadow: "Synthetic test only",
            uncertainty: [],
          },
        ],
        teachings: [
          {
            id: "teaching",
            segmentIds: ["synthetic-segment"],
            kind: "conclusion",
            nativeSummary: "కృత్రిమ పరీక్ష మాత్రమే",
            englishShadow: "Synthetic test only",
            requiredContextIds: [],
          },
        ],
        candidates: [
          {
            id: "candidate",
            segmentIds: ["synthetic-segment"],
            startMs: 0,
            endMs: 1000,
            rationale: "Complete synthetic test source",
            attributedSpeakerId: "synthetic",
            checks: INTEGRITY_CHECKS.map((check) => ({
              check,
              status: "REVIEW",
              evidence: "Native reviewer evidence required",
              segmentIds: ["synthetic-segment"],
            })),
            scores: {
              fidelity: 1,
              selfContainment: 1,
              contextCompleteness: 1,
              significance: 0,
              clarity: 1,
              accessibility: 1,
              visualSuitability: 0,
              hook: 0,
            },
          },
        ],
        provenance: {
          provider: "manual",
          model: "synthetic",
          promptVersion: "v1",
          schemaVersion: 1,
        },
      };
      await author.goto(`${origin}/distribution`);
      await author.getByRole("button", { name: "Master library", exact: true }).click();
      await author.getByRole("searchbox", { name: "Search content" }).fill(title);
      await author.getByRole("button", { name: new RegExp(title) }).click();
      const panel = author
        .locator("details")
        .filter({ has: author.locator("summary").filter({ hasText: /^Native teaching review$/ }) });
      await panel.locator("summary").first().click();
      const upload = {
        name: "synthetic-analysis.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(analysis)),
      };
      let loseResponse = true;
      await author.route(`**/distribution/api/native/${contentId}`, async (route) => {
        if (route.request().method() === "POST" && loseResponse) {
          loseResponse = false;
          const committed = await route.fetch();
          expect(committed.status()).toBe(201);
          await route.abort("failed");
        } else await route.continue();
      });
      await panel.getByLabel("Import source-linked teaching analysis").setInputFiles(upload);
      await expect(panel.getByRole("alert")).toBeVisible();
      await panel.getByLabel("Import source-linked teaching analysis").setInputFiles(upload);
      await expect(
        panel.getByRole("heading", { name: "Candidate · 0.0–1.0 seconds" }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Open approved boundaries in Variant Studio" }),
      ).toHaveCount(0);
      const saved = await author.request.get(`${origin}/distribution/api/native/${contentId}`);
      expect((await saved.json()).analyses).toHaveLength(1);
      await expect(
        panel.getByRole("button", { name: "Approve native boundaries", exact: true }),
      ).toHaveCount(0);
      const savedAnalysis = (
        await (await author.request.get(`${origin}/distribution/api/native/${contentId}`)).json()
      ).analyses[0];
      const refusedNativeApproval = await author.request.post(
        `${origin}/distribution/api/native/${contentId}`,
        {
          headers: { origin },
          data: {
            action: "review",
            requestId: randomUUID(),
            analysisId: savedAnalysis.id,
            candidateId: "candidate",
            expectedRevision: 0,
            decision: "APPROVED",
            reason: "Author cannot approve their proposal",
            checks: INTEGRITY_CHECKS.map((check) => ({
              check,
              evidence: "Synthetic author refusal check",
            })),
          },
        },
      );
      expect(refusedNativeApproval.status()).toBe(403);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin}/distribution`);
      await page.getByRole("button", { name: "Master library", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search content" }).fill(title);
      await page.getByRole("button", { name: new RegExp(title) }).click();
      const reviewPanel = page
        .locator("details")
        .filter({ has: page.locator("summary").filter({ hasText: /^Native teaching review$/ }) });
      await reviewPanel.locator("summary").first().click();
      await expect(reviewPanel.getByLabel("Import source-linked teaching analysis")).toHaveCount(0);
      await expect(
        reviewPanel.getByRole("heading", { name: "Candidate · 0.0–1.0 seconds" }),
      ).toBeVisible();
      const approve = reviewPanel.getByRole("button", {
        name: "Approve native boundaries",
        exact: true,
      });
      await expect(approve).toBeDisabled();
      for (const field of await reviewPanel
        .getByRole("textbox", { name: /review evidence$/ })
        .all())
        await field.fill("Reviewed the synthetic source, complete context and attribution.");
      await reviewPanel
        .getByLabel("Decision reason")
        .fill("Synthetic fixture only; validates the review workflow, not semantic quality.");
      await approve.click();
      await expect(reviewPanel.getByText(/Recorded decision: approved/)).toBeVisible();
      await expect(
        reviewPanel.getByRole("button", { name: "Open approved boundaries in Variant Studio" }),
      ).toHaveCount(0);
      const reviewedNative = await page.request.get(
        `${origin}/distribution/api/native/${contentId}`,
      );
      expect((await reviewedNative.json()).reviews[0].review.reviewerId).toBe(reviewerIdentity.id);
      await page.screenshot({
        path: info.outputPath("native-review-admin-phone.png"),
        fullPage: true,
      });
      await author.reload();
      await author.getByRole("button", { name: "Master library", exact: true }).click();
      await author.getByRole("searchbox", { name: "Search content" }).fill(title);
      await author.getByRole("button", { name: new RegExp(title) }).click();
      await panel.locator("summary").first().click();
      await panel
        .getByRole("button", { name: "Open approved boundaries in Variant Studio" })
        .click();
      const variants = author
        .locator("details")
        .filter({ has: author.locator("summary").filter({ hasText: /^Versions for sharing$/ }) });
      await expect(variants.locator('input[name="start"]')).toHaveValue("0");
      await expect(variants.locator('input[name="end"]')).toHaveValue("1");
      expect(await author.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        391,
      );
      await author.screenshot({ path: info.outputPath("native-review-phone.png"), fullPage: true });
    } finally {
      if (contentId) {
        const current = await page.request.get(
          `${origin}/distribution/api/content/${contentId}/detail`,
        );
        if (current.ok())
          await page.request.post(`${origin}/distribution/api/content/${contentId}/withdraw`, {
            headers: { origin },
            data: {
              expectedRevision: (await current.json()).content.revision,
              reason: "Local synthetic browser fixture complete",
            },
          });
      }
      await authorContext.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
