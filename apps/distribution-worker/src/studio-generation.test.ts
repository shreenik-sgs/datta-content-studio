import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateAssetStore } from "@satsang/distribution-assets";
import type { StudioGenerationClaim } from "@satsang/distribution-db";
import {
  STUDIO_BOUNDARY_REVIEW_POLICY,
  STUDIO_CHANNELS,
  STUDIO_MEDIA_DEFAULTS,
  type StudioPackage,
  createLocalStudioPlan,
  parseStudioAssetDescriptor,
} from "@satsang/distribution-domain";
import { STUDIO_PICTURE } from "@satsang/distribution-domain";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundaries from "./studio-boundary-review";
import * as quality from "./studio-content-review";
import * as contextualImages from "./studio-context-images";
import { generateStudioPackage } from "./studio-generation";
import * as intelligence from "./studio-intelligence";
import * as mediaRenderer from "./studio-media";
import { studioCaptionPages, studioVtt } from "./studio-media";
import * as presentation from "./studio-presentation-review";
import * as studioProcess from "./studio-process";
import { executeStudioSource } from "./studio-process";
import * as sarvam from "./studio-sarvam";

const ffmpeg =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const ffprobe =
  process.env.DISTRIBUTION_TEST_FFPROBE ??
  (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
let root: string;
let claim: StudioGenerationClaim;
let env: Record<string, string>;
let store: ReturnType<typeof createPrivateAssetStore>;
beforeAll(async () => {
  root = await mkdtemp(join(realpathSync(tmpdir()), "studio-generation-test-"));
  const sourcePath = join(root, "synthetic.mp4");
  execFileSync(
    ffmpeg,
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      sourcePath,
    ],
    { timeout: 15000 },
  );
  store = createPrivateAssetStore(join(root, "assets"));
  const asset = await store.write({
    bytes: await readFile(sourcePath),
    mimeType: "video/mp4",
    originalName: "synthetic.mp4",
  });
  const masterId = randomUUID();
  const versionId = randomUUID();
  const pkg: StudioPackage = {
    id: randomUUID(),
    isTest: true,
    revision: 1,
    status: "GENERATING",
    source: {
      masterId,
      versionId,
      sha256: asset.sha256,
      revision: 1,
      title: "Synthetic kindness demonstration",
      language: "en",
      category: "pravachanams",
      mimeType: "video/mp4",
    },
    createdBy: randomUUID(),
    contributorIds: [],
    request: {
      languages: ["en"],
      channels: [...STUDIO_CHANNELS],
      instructions: "",
      captions: true,
    },
    outputs: [],
    provenance: null,
    approval: null,
    feedback: [],
    failure: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  claim = {
    id: randomUUID(),
    package: pkg,
    source: { ...asset, masterId, versionId },
    transcript: {
      language: "en",
      durationMs: 2000,
      segments: [
        { id: "one", startMs: 0, endMs: 1000, text: "Practice kindness." },
        { id: "two", startMs: 1000, endMs: 2000, text: "Serve with care." },
      ],
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
    },
    externalProcessing: { allowed: false, reason: "RIGHTS_MISSING" },
    leaseToken: randomUUID(),
    leaseOwner: "studio-test",
    attempts: 1,
  };
  const logo = join(root, "logo.png");
  await writeFile(
    logo,
    await sharp({ create: { width: 100, height: 100, channels: 4, background: "#a12b58" } })
      .png()
      .toBuffer(),
    { mode: 0o600 },
  );
  env = {
    STUDIO_GENERATION_ENABLED: "true",
    STUDIO_INTELLIGENCE_PROVIDER: "local",
    STUDIO_BRAND_LOGO_PATH: logo,
    STUDIO_SCRATCH_ROOT: join(root, "scratch"),
    DISTRIBUTION_FFMPEG_PATH: ffmpeg,
    DISTRIBUTION_FFPROBE_PATH: ffprobe,
  };
}, 20000);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(boundaries, "reviewStudioClipBoundaries").mockImplementation(async (input) => {
    const edge = {
      verdict: "complete" as const,
      audibleWords: "Synthetic complete phrase.",
      meaning: "Synthetic complete phrase.",
      reason: "Test fixture.",
      needsOutsideSpeech: false,
      cutDuringWord: false,
    };
    return {
      policy: STUDIO_BOUNDARY_REVIEW_POLICY,
      startMs: input.startMs,
      endMs: input.endMs,
      opening: edge,
      ending: edge,
    };
  });
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("automatic Studio generation with real media", () => {
  it.each([
    undefined,
    { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" },
  ])(
    "repairs and reviews actual bytes while retaining the requested closing target (%j)",
    async (youtubeClosing) => {
      vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async ({ pkg, transcript }) =>
        createLocalStudioPlan(pkg, transcript),
      );
      vi.spyOn(quality, "reviewStudioContent").mockResolvedValue([
        {
          channel: "youtube",
          language: "en",
          openingComplete: true,
          endingComplete: true,
          contextComplete: true,
          attributionCorrect: true,
          captionsFaithful: true,
          copySupported: true,
          reason: "Complete fixture.",
        },
      ]);
      vi.spyOn(presentation, "screenStudioSource").mockResolvedValue({
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Complete fixture with a pause.",
        scenes: [{ startMs: 0, endMs: 2000, bodyTop: 0, bodyBottom: 0.9 }],
        illustrations: [],
      });
      const checks = {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Verified actual rendered fixture.",
      };
      const review = vi
        .spyOn(presentation, "reviewStudioPresentation")
        .mockResolvedValueOnce({
          ...checks,
          textIntact: false,
          reason: "A source name is cut off.",
        })
        .mockResolvedValueOnce(checks);
      const result = await generateStudioPackage({
        claim: {
          ...claim,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: {
              ...claim.package.request,
              channels: ["youtube"],
              ...(youtubeClosing
                ? { youtubeClosing, sourceBranding: "bala-swamiji" as const }
                : {}),
            },
          },
        },
        store,
        env: {
          ...env,
          ...(youtubeClosing
            ? { STUDIO_BRAND_LOGO_PATH: "/nonexistent-must-not-load-default-portrait.png" }
            : {}),
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "gemini-test",
        },
      });
      expect(review).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(boundaries.reviewStudioClipBoundaries)
          .mock.calls.some(
            ([input]) => input.fileStartMs === 0 && input.sourcePath.endsWith(".mp4"),
          ),
      ).toBe(true);
      expect(result.outputs).toHaveLength(1);
      if (youtubeClosing) {
        expect(result.provenance).toMatchObject({
          sourceBranding: "bala-swamiji",
          brandName: "Sri Datta Vijayananda Teertha Swamiji",
          brandLogoSha256: null,
        });
        expect(result.outputs[0]?.body).not.toContain("@sgsswamiji");
        expect(result.outputs[0]?.presentationReview?.openingCard).toBeUndefined();
        expect(result.outputs[0]?.body).toContain(
          `Subscribe to ${youtubeClosing.label}: ${youtubeClosing.url}`,
        );
        expect(review.mock.calls.at(-1)?.[0].context).toMatchObject({
          closingCard: { youtubeClosing },
        });
      }
      expect(result.outputs[0]?.presentationReview).toMatchObject({
        repairs: 1,
        framing: "full-picture",
        renderedSha256: result.outputs[0]?.asset?.sha256,
        fileVersion: 1,
        source: { scenes: [], illustrations: [] },
        closingCard: {
          startMs: 0,
          endMs: 5000,
          speechEndMs: 2000,
          cleanHoldMs: 3000,
          transitionMs: 400,
          ...(youtubeClosing
            ? { destination: "youtube", youtubeClosing, channelUrl: youtubeClosing.url }
            : { appLinks: { web: "https://sgsdattasannidhi.org/" } }),
        },
      });
      const asset = result.outputs[0]?.asset;
      if (!asset) throw Error("Expected rendered fixture");
      const finished = join(root, "closing-reviewed.mp4");
      await writeFile(finished, await store.readDerivedDescriptor(asset));
      const metadata = JSON.parse(
        execFileSync(ffprobe, ["-v", "error", "-show_format", "-of", "json", finished], {
          encoding: "utf8",
        }),
      );
      expect(Number(metadata.format.duration)).toBeCloseTo(5, 1);
      const lastAudio = execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        "1.6",
        "-i",
        finished,
        "-t",
        "0.3",
        "-f",
        "s16le",
        "-ac",
        "1",
        "pipe:1",
      ]);
      expect(lastAudio.some((byte) => byte !== 0)).toBe(true); // The closing image never mutes the voice.
      const lastFrame = join(root, `closing-reviewed-${youtubeClosing ? "custom" : "default"}.png`);
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        "1.8",
        "-i",
        finished,
        "-frames:v",
        "1",
        lastFrame,
      ]);
      const corner = await sharp(await readFile(lastFrame))
        .extract({ left: 2, top: 2, width: 1, height: 1 })
        .raw()
        .toBuffer();
      expect(corner[0]).toBeLessThan(80); // Opaque closing card, no frozen speaker frame.
      expect(review.mock.calls.at(-1)?.[0].context).toMatchObject({ closingCard: { endMs: 5000 } });
      const holdFrame = join(root, `clean-hold-${youtubeClosing ? "custom" : "default"}.png`);
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        "4.5",
        "-i",
        finished,
        "-frames:v",
        "1",
        holdFrame,
      ]);
      const holdBand = await sharp(
        await sharp(holdFrame)
          .extract({ left: 64, top: 1682, width: 884, height: 200 })
          .png()
          .toBuffer(),
      ).stats();
      expect(holdBand.channels.slice(0, 3).every((c) => c.stdev < 4 && c.max < 80)).toBe(true);
      const tailAudio = execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        "3",
        "-i",
        finished,
        "-t",
        "1",
        "-vn",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      expect(tailAudio.some((byte) => byte !== 0)).toBe(false);
      review.mockResolvedValue(checks);
      const editorialCalls = vi.mocked(quality.reviewStudioContent).mock.calls.length;
      const boundaryCalls = vi.mocked(boundaries.reviewStudioClipBoundaries).mock.calls.length;
      const presentationCalls = review.mock.calls.length;
      const imageGeneration = vi
        .spyOn(contextualImages, "studioContextIllustrationShots")
        .mockRejectedValue(Error("A closing-only repair must not create new imagery"));
      const replacement = await generateStudioPackage({
        claim: {
          ...claim,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            outputs: result.outputs,
            provenance: result.provenance,
            request: {
              ...claim.package.request,
              channels: ["youtube"],
              ...(youtubeClosing
                ? { youtubeClosing, sourceBranding: "bala-swamiji" as const }
                : {}),
            },
            generation: {
              mode: "closing",
              outputIds: [result.outputs[0]?.id ?? "missing"],
              closingDestinations: { [result.outputs[0]?.id ?? "missing"]: "youtube" },
            },
          },
        },
        store,
        env: {
          ...env,
          ...(youtubeClosing
            ? { STUDIO_BRAND_LOGO_PATH: "/nonexistent-must-not-load-default-portrait.png" }
            : {}),
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "gemini-test",
        },
      });
      expect(imageGeneration).not.toHaveBeenCalled();
      expect(quality.reviewStudioContent).toHaveBeenCalledTimes(editorialCalls);
      expect(boundaries.reviewStudioClipBoundaries).toHaveBeenCalledTimes(boundaryCalls);
      expect(review).toHaveBeenCalledTimes(presentationCalls);
      const refreshed = replacement.outputs[0];
      const original = result.outputs[0];
      expect(refreshed?.captionCues).toEqual(original?.captionCues);
      expect(refreshed?.captions).toEqual(original?.captions);
      expect(refreshed?.mediaEdits).toEqual(original?.mediaEdits);
      expect(refreshed?.aiReview?.reviewedAt).toEqual(original?.aiReview?.reviewedAt);
      expect(refreshed?.presentationReview?.closingRefresh).toMatchObject({
        policy: "preserved-export-closing-v1",
        previousSha256: original?.asset?.sha256,
        previousFileVersion: 1,
      });
      expect(
        refreshed?.presentationReview?.closingRefresh?.minimumCaptionSsim,
      ).toBeGreaterThanOrEqual(0.995);
      expect(replacement.outputs[0]?.presentationReview?.closingCard).toMatchObject({
        destination: "youtube",
        channelUrl: youtubeClosing?.url ?? "https://www.youtube.com/@sgsswamiji",
        ...(youtubeClosing ? { youtubeClosing, sourceBranding: "bala-swamiji" as const } : {}),
      });
      expect(replacement.outputs[0]?.thumbnail).toMatchObject({ mimeType: "image/png" });
      expect(replacement.outputs[0]).toMatchObject({
        id: result.outputs[0]?.id,
        fileVersion: 2,
        title: result.outputs[0]?.title,
        startMs: 0,
        endMs: 2000,
      });
      expect(replacement.outputs[0]?.presentationReview?.source.scenes).toEqual(
        result.outputs[0]?.presentationReview?.source.scenes,
      );
    },
    90000,
  );
  it("holds the finished file when blind audio review contradicts a passed source and presentation", async () => {
    vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async ({ pkg, transcript }) =>
      createLocalStudioPlan(pkg, transcript),
    );
    vi.spyOn(quality, "reviewStudioContent").mockResolvedValue([
      {
        channel: "youtube",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: true,
        reason: "Complete source fixture.",
      },
    ]);
    vi.spyOn(presentation, "screenStudioSource").mockResolvedValue({
      openingComplete: true,
      endingComplete: true,
      naturalStart: true,
      naturalEnd: true,
      reason: "Source passed.",
      scenes: [],
      illustrations: [],
    });
    vi.spyOn(presentation, "reviewStudioPresentation").mockResolvedValue({
      illustrationsRelevant: true,
      textIntact: true,
      subjectIntact: true,
      captionsClear: true,
      naturalBoundaries: true,
      reason: "Broad presentation passed.",
    });
    const boundary = vi.mocked(boundaries.reviewStudioClipBoundaries);
    const original = boundary.getMockImplementation();
    if (!original) throw Error("Missing boundary fixture");
    boundary.mockImplementation(async (input) => {
      const value = await original(input);
      return input.fileStartMs === 0
        ? {
            ...value,
            ending: {
              ...value.ending,
              verdict: "incomplete",
              cutDuringWord: true,
              audibleWords: "Clipped final syllable",
              reason: "Actual finished audio cuts off.",
            },
          }
        : value;
    });
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    await expect(
      generateStudioPackage({
        claim: {
          ...claim,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["youtube"] },
          },
        },
        store,
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "gemini-test",
        },
      }),
    ).rejects.toThrow("STUDIO_PRESENTATION_BOUNDARY_REQUIRED");
    expect(boundary.mock.calls.some(([input]) => input.fileStartMs === 0)).toBe(true);
    expect(write.mock.calls.some(([input]) => input.mimeType === "video/mp4")).toBe(false);
  }, 30000);

  it.each([false, true])(
    "records a rejected final-media candidate without losing passing files or repeating paid work (all rejected: %s)",
    async (allRejected) => {
      vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(
        async ({ pkg, transcript }) => {
          const plan = createLocalStudioPlan(
            { ...pkg, request: { ...pkg.request, allCompleteMessages: false } },
            transcript,
          );
          const template = plan.outputs[0];
          if (!template) throw Error("Missing fixture output");
          return {
            ...plan,
            outputs: transcript.segments.map((segment, index) => ({
              ...template,
              messageId: `message-${index + 1}`,
              title: index ? "Second teaching" : "First teaching",
              sourceSegmentIds: [segment.id],
            })),
          };
        },
      );
      vi.spyOn(quality, "reviewStudioContent").mockImplementation(async ({ plan }) =>
        plan.outputs.map((output) => ({
          channel: output.channel,
          language: output.language,
          ...(output.messageId ? { messageId: output.messageId } : {}),
          openingComplete: true,
          endingComplete: true,
          contextComplete: true,
          attributionCorrect: true,
          captionsFaithful: true,
          copySupported: true,
          reason: "Source fixture passed.",
        })),
      );
      vi.spyOn(presentation, "screenStudioSource").mockResolvedValue({
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Source passed.",
        scenes: [],
        illustrations: [],
      });
      vi.spyOn(presentation, "reviewStudioPresentation").mockResolvedValue({
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Presentation passed.",
      });
      const boundary = vi.mocked(boundaries.reviewStudioClipBoundaries);
      const original = boundary.getMockImplementation();
      if (!original) throw Error("Missing boundary fixture");
      boundary.mockImplementation(async (input) => {
        const value = await original(input);
        return input.fileStartMs === 0 && (allRejected || input.startMs === 1000)
          ? {
              ...value,
              opening: {
                ...value.opening,
                verdict: "incomplete",
                needsOutsideSpeech: true,
                audibleWords: "An incomplete opening",
                reason: "The rendered clip begins mid-verse.",
              },
            }
          : value;
      });
      const saved = new Map<string, unknown>();
      const render = vi.spyOn(mediaRenderer, "renderStudioVideo");
      const attempt = () =>
        generateStudioPackage({
          claim: {
            ...claim,
            externalProcessing: { allowed: true, reason: null },
            package: {
              ...claim.package,
              request: {
                ...claim.package.request,
                channels: ["youtube"],
                allCompleteMessages: true,
              },
            },
          },
          store,
          checkpoints: {
            get: <T>(key: string, fingerprint: string) =>
              structuredClone(saved.get(`${key}:${fingerprint}`)) as T | undefined,
            set: async (key, fingerprint, value) => {
              saved.set(`${key}:${fingerprint}`, structuredClone(value));
            },
            progress: async () => {},
          },
          env: {
            ...env,
            STUDIO_INTELLIGENCE_PROVIDER: "gemini",
            STUDIO_GEMINI_API_KEY: "synthetic",
            STUDIO_GEMINI_MODEL: "gemini-test",
          },
        });
      if (allRejected) {
        await expect(attempt()).rejects.toThrow("STUDIO_PRESENTATION_BOUNDARY_REQUIRED");
        await expect(attempt()).rejects.toThrow("STUDIO_PRESENTATION_BOUNDARY_REQUIRED");
      } else {
        const first = await attempt();
        expect(first.outputs).toHaveLength(1);
        expect(first.outputs[0]?.messageId).toBe("message-1");
        expect(first.provenance.excludedMessages).toEqual([
          expect.objectContaining({
            messageId: "message-2",
            reasons: [expect.stringContaining("begins mid-verse")],
          }),
        ]);
        const resumed = await attempt();
        expect(
          resumed.outputs.map((o) => ({ id: o.id, asset: o.asset, captions: o.captions })),
        ).toEqual(first.outputs.map((o) => ({ id: o.id, asset: o.asset, captions: o.captions })));
      }
      expect(render).toHaveBeenCalledTimes(2);
      expect(boundary.mock.calls.filter(([input]) => input.fileStartMs === 0)).toHaveLength(2);
      expect(
        [...saved.keys()].filter((key) => key.startsWith("render-boundary-rejection:")),
      ).toHaveLength(allRejected ? 2 : 1);
    },
    60000,
  );

  it("holds an abrupt actual ending even when the transcript reviewer passed it", async () => {
    vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async ({ pkg, transcript }) =>
      createLocalStudioPlan(pkg, transcript),
    );
    vi.spyOn(quality, "reviewStudioContent").mockResolvedValue([
      {
        channel: "youtube",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: true,
        reason: "Transcript looked complete.",
      },
    ]);
    const screen = vi.spyOn(presentation, "screenStudioSource").mockResolvedValue({
      openingComplete: true,
      endingComplete: false,
      naturalStart: true,
      naturalEnd: false,
      reason: "Actual audio cuts inside the final word; choose the following complete sentence.",
      scenes: [],
      illustrations: [],
    });
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    await expect(
      generateStudioPackage({
        claim: {
          ...claim,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["youtube"] },
          },
        },
        store,
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "gemini-test",
        },
      }),
    ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
    expect(screen).toHaveBeenCalledTimes(1); // The unchanged excerpt is not sent repeatedly while drafting retries.
    expect(write).not.toHaveBeenCalled();
  }, 30000);

  it("cannot render a boundary failure despite a positive general review", async () => {
    vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async ({ pkg, transcript }) =>
      createLocalStudioPlan(pkg, transcript),
    );
    vi.spyOn(quality, "reviewStudioContent").mockResolvedValue([
      {
        channel: "youtube",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: true,
        reason: "The broad reviewer accepted an earlier complete lesson.",
      },
    ]);
    const edge = {
      verdict: "complete" as const,
      audibleWords: "A complete opening.",
      meaning: "A complete opening.",
      reason: "Fixture",
      needsOutsideSpeech: false,
      cutDuringWord: false,
    };
    const boundary = vi.mocked(boundaries.reviewStudioClipBoundaries).mockResolvedValue({
      policy: STUDIO_BOUNDARY_REVIEW_POLICY,
      startMs: 0,
      endMs: 2000,
      opening: edge,
      ending: {
        ...edge,
        verdict: "incomplete",
        audibleWords: "The value of this language...",
        needsOutsideSpeech: true,
      },
    });
    const stop = new AbortController();
    const screen = vi.spyOn(presentation, "screenStudioSource");
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    const saved = new Map<string, unknown>();
    const attempt = (transcript = claim.transcript) =>
      generateStudioPackage({
        claim: {
          ...claim,
          transcript,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["youtube"] },
          },
        },
        store,
        signal: stop.signal,
        checkpoints: {
          get: <T>(key: string, fingerprint: string) =>
            saved.get(`${key}:${fingerprint}`) as T | undefined,
          set: async (key, fingerprint, value) => {
            saved.set(`${key}:${fingerprint}`, value);
          },
          progress: async () => {},
        },
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "gemini-test",
        },
      });
    await expect(attempt()).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
    await expect(attempt()).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
    expect(boundary).toHaveBeenCalledTimes(1);
    expect(boundary.mock.calls[0]?.[0].signal).toBe(stop.signal);
    if (!claim.transcript) throw Error("Missing fixture transcript");
    await expect(
      attempt({
        ...claim.transcript,
        segments: claim.transcript.segments.map((segment) => ({
          ...segment,
          text: `${segment.text} Corrected source text.`,
        })),
      }),
    ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
    expect(boundary).toHaveBeenCalledTimes(2);
    expect(screen).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  }, 30000);

  it("creates verifiable branded short/reel/post/blog files, visible captions and source-bound names", async () => {
    const render = vi.spyOn(mediaRenderer, "renderStudioVideo");
    const result = await generateStudioPackage({ claim, store, env });
    expect(result.outputs).toHaveLength(12);
    const videos = result.outputs.filter((o) => ["short", "reel"].includes(o.format));
    expect(videos).toHaveLength(4);
    expect(render).toHaveBeenCalledTimes(1);
    expect(new Set(videos.map((o) => o.asset?.storageKey)).size).toBe(1);
    expect(new Set(videos.map((o) => o.asset?.filename)).size).toBe(4);
    expect(result.outputs.find((output) => output.channel === "whatsapp")).toMatchObject({
      format: "post",
      asset: { mimeType: "image/png" },
    });
    expect(new Set(result.outputs.map((o) => o.format))).toEqual(
      new Set(["short", "reel", "post", "blog"]),
    );
    expect(result.provenance.provider).toBe("local");
    expect(result.provenance.promptVersion).toBe("ashrama-studio-v2");
    expect(result.provenance.transcript.provenance).toBe("MACHINE_TRANSCRIPT");
    for (const output of result.outputs) {
      if (!output.asset) throw new Error("Missing generated asset");
      const data = await store.readDerivedDescriptor(output.asset);
      expect(createHash("sha256").update(data).digest("hex")).toBe(output.asset.sha256);
      const name = parseStudioAssetDescriptor(output.asset);
      expect(name?.identity.masterId).toBe(claim.source.masterId);
      expect(name?.identity.sourceVersionId).toBe(claim.source.versionId);
      expect(name?.identity.channel).toBe(output.channel);
      expect(output.body).toContain("@sgsswamiji");
      if (output.format === "short" || output.format === "reel") {
        const path = join(root, `${output.id}.mp4`);
        await writeFile(path, data, { mode: 0o600 });
        const probe = JSON.parse(
          execFileSync(
            ffprobe,
            ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
            { encoding: "utf8" },
          ),
        );
        expect(
          probe.streams.find((s: { codec_type: string }) => s.codec_type === "video"),
        ).toMatchObject({ width: 1080, height: 1920 });
        expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(
          true,
        );
        expect(Number(probe.format.duration)).toBeCloseTo(5, 0);
        const frame = execFileSync(
          ffmpeg,
          [
            "-v",
            "error",
            "-ss",
            "0.5",
            "-i",
            path,
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
          ],
          { maxBuffer: 5 * 1024 * 1024 },
        );
        const caption = await sharp(
          await sharp(frame)
            .extract({
              left: 68,
              top:
                Math.round(
                  STUDIO_PICTURE.y +
                    (STUDIO_PICTURE.height + (STUDIO_PICTURE.width * 180) / 320) / 2 +
                    12,
                ) + 20,
              width: 12,
              height: 40,
            })
            .toBuffer(),
        ).stats();
        expect(caption.channels[0]?.mean).toBeLessThan(80);
        const captionAsset = output.captions[0]?.asset;
        if (!captionAsset) throw new Error("Missing captions");
        expect((await store.readDerivedDescriptor(captionAsset)).toString()).toContain(
          "Practice kindness.",
        );
      } else if (output.format === "post")
        expect(await sharp(data).metadata()).toMatchObject({ width: 1080, height: 1350 });
      else expect(data.toString()).toContain("Sri Ganapathy Sachchidananda Swamiji");
    }
    expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
  }, 90000);
  it("does not render or expose an initial article until its AI review passes", async () => {
    vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async ({ pkg, transcript }) =>
      createLocalStudioPlan(pkg, transcript),
    );
    const review = vi.spyOn(quality, "reviewStudioContent").mockResolvedValue([
      {
        channel: "website",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: false,
        reason: "The article adds a promise not present in the source.",
      },
    ]);
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    await expect(
      generateStudioPackage({
        claim: {
          ...claim,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["website"] },
          },
        },
        store,
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic",
          STUDIO_GEMINI_MODEL: "synthetic",
        },
      }),
    ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
    expect(review).toHaveBeenCalledTimes(4);
    expect(write).not.toHaveBeenCalled();
  }, 90000);
  it("renders only the selected file and leaves the other media and metadata byte-identical", async () => {
    const first = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          request: { ...claim.package.request, channels: ["x", "website"] },
        },
      },
      store,
      env,
    });
    const target = first.outputs.find((o) => o.channel === "website");
    const untouched = first.outputs.find((o) => o.channel === "x");
    if (!target || !untouched || !target.asset) throw new Error("Missing fixtures");
    const oldBytes = await store.readDerivedDescriptor(target.asset);
    const original = JSON.stringify(untouched);
    const edited = {
      ...target,
      body: "Corrected source-based copy.\n\n@sgsswamiji",
      asset: null,
      correction: {
        comment: "Make this concise",
        reviewerId: "reviewer",
        requestedAt: new Date().toISOString(),
        state: "pending" as const,
        before: {
          title: target.title,
          body: target.body,
          sourceSegmentIds: target.sourceSegmentIds,
        },
      },
    };
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    const network = vi.spyOn(globalThis, "fetch");
    const result = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          outputs: [untouched, edited],
          provenance: first.provenance,
          generation: { outputIds: [target.id], mode: "render" },
        },
      },
      store,
      env,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outputs[0])).toBe(original);
    expect(result.provenance).toEqual(first.provenance);
    const corrected = result.outputs[1];
    expect(corrected).toMatchObject({
      id: target.id,
      body: edited.body,
      fileVersion: 2,
      correction: { state: "revised" },
    });
    expect(corrected?.asset?.storageKey).not.toBe(target.asset.storageKey);
    expect(await store.readDerivedDescriptor(target.asset)).toEqual(oldBytes);
    expect(corrected?.asset?.filename).toContain("_v2_");
  }, 90000);
  it("corrects selected channel versions of one teaching together without changing other files", async () => {
    const sourceClaim = {
      ...claim,
      package: {
        ...claim.package,
        request: {
          ...claim.package.request,
          channels: ["youtube", "facebook", "x"] as StudioPackage["request"]["channels"],
        },
      },
    };
    const first = await generateStudioPackage({ claim: sourceClaim, store, env });
    const outputs = first.outputs.map((output) =>
      output.channel === "x" ? output : { ...output, messageId: "message-01" },
    );
    const selected = outputs.filter((output) => output.channel !== "x");
    const untouched = outputs.find((output) => output.channel === "x");
    const planner = vi
      .spyOn(intelligence, "generateStudioPlan")
      .mockImplementation(async ({ pkg, transcript }) => {
        const plan = createLocalStudioPlan(
          { ...pkg, request: { ...pkg.request, allCompleteMessages: false } },
          transcript,
        );
        return {
          ...plan,
          outputs: plan.outputs.map((output) => ({ ...output, messageId: "message-01" })),
        };
      });
    const result = await generateStudioPackage({
      claim: {
        ...sourceClaim,
        package: {
          ...sourceClaim.package,
          request: { ...sourceClaim.package.request, allCompleteMessages: true },
          outputs,
          provenance: first.provenance,
          generation: { outputIds: selected.map((output) => output.id), mode: "ai" },
        },
      },
      store,
      env,
      checkpoints: {
        get: () => undefined,
        set: async (key, fingerprint, value) => {
          expect(key).toMatch(/^[a-z0-9:_-]{1,160}$/);
          expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
          expect(JSON.stringify(value).length).toBeLessThan(4 * 1024 * 1024);
        },
        progress: async () => {},
      },
    });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(planner.mock.calls[0]?.[0].pkg.outputs.map((output) => output.id)).toEqual(
      selected.map((output) => output.id),
    );
    expect(result.outputs.find((output) => output.channel === "x")).toEqual(untouched);
    for (const prior of selected)
      expect(result.outputs.find((output) => output.id === prior.id)).toMatchObject({
        fileVersion: 2,
        messageId: "message-01",
        sourceSegmentIds: prior.sourceSegmentIds,
      });
    // This renders both the original and corrected YouTube/Facebook variants.
    // Match the other real-media tests' bounded allowance on shared CI runners.
  }, 90000);
  it("sends only the selected draft and its file comment to the AI planner", async () => {
    const first = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          request: { ...claim.package.request, channels: ["x", "website"] },
        },
      },
      store,
      env,
    });
    const target = first.outputs.find((o) => o.channel === "website");
    if (!target) throw new Error("Missing fixture");
    const planner = vi.spyOn(intelligence, "generateStudioPlan");
    const edited = {
      ...target,
      correction: {
        comment: "Shorten this blog only",
        reviewerId: "reviewer",
        requestedAt: new Date().toISOString(),
        state: "pending" as const,
        before: {
          title: target.title,
          body: target.body,
          sourceSegmentIds: target.sourceSegmentIds,
        },
      },
    };
    await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          outputs: first.outputs.map((o) => (o.id === target.id ? edited : o)),
          provenance: first.provenance,
          generation: { outputIds: [target.id], mode: "ai" },
        },
      },
      store,
      env,
    });
    expect(planner).toHaveBeenCalledTimes(1);
    const request = planner.mock.calls[0]?.[0].pkg;
    expect(request?.request.channels).toEqual(["website"]);
    expect(request?.outputs.map((o) => o.id)).toEqual([target.id]);
    expect(request?.feedback.map((f) => f.comment)).toEqual(["Shorten this blog only"]);
  }, 90000);
  it("renders an exact sub-passage trim with rebased subtitles and a retained closing card", async () => {
    const first = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          request: { ...claim.package.request, channels: ["youtube", "website"] },
        },
      },
      store,
      env,
    });
    const target = first.outputs.find((o) => o.channel === "youtube");
    if (!target) throw Error("MISSING_FIXTURE");
    const trim = { startMs: 500, endMs: 1750 };
    const edited = {
      ...target,
      sourceTrim: trim,
      startMs: trim.startMs,
      endMs: trim.endMs,
      asset: null,
      closingDestination: "youtube" as const,
      captionCues: first.provenance.transcript.segments.map((s) => ({
        ...s,
        startMs: Math.max(s.startMs, trim.startMs),
        endMs: Math.min(s.endMs, trim.endMs),
      })),
    };
    const result = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          outputs: first.outputs.map((o) => (o.id === target.id ? edited : o)),
          provenance: first.provenance,
          generation: { outputIds: [target.id], mode: "render" },
        },
      },
      store,
      env,
    });
    const output = result.outputs.find((o) => o.id === target.id);
    expect(output).toMatchObject({ sourceTrim: trim, startMs: 500, endMs: 1750, fileVersion: 2 });
    expect(result.outputs.find((o) => o.channel === "website")).toEqual(
      first.outputs.find((o) => o.channel === "website"),
    );
    expect(result.provenance.transcript).toEqual(first.provenance.transcript);
    if (!output?.asset || !output.captions[0]) throw Error("MISSING_RENDER");
    const vtt = (await store.readDerivedDescriptor(output.captions[0].asset)).toString();
    expect(vtt).toContain("00:00:00.000 --> 00:00:00.500");
    expect(vtt).toContain("00:00:00.500 --> 00:00:01.250");
    const file = join(root, "exact-trim-result.mp4");
    await writeFile(file, await store.readDerivedDescriptor(output.asset));
    const duration = Number(
      execFileSync(
        ffprobe,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
        { encoding: "utf8" },
      ).trim(),
    );
    expect(duration).toBeGreaterThanOrEqual(4.2);
    expect(duration).toBeLessThan(4.4);
    expect(output.closingDestination).toBe("youtube");
  }, 90000);
  it.each([true, false])(
    "renders manual media and caption overrides without replanning (captions=%s)",
    async (captionsEnabled) => {
      const first = await generateStudioPackage({
        claim: {
          ...claim,
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["youtube"] },
          },
        },
        store,
        env,
      });
      const target = first.outputs[0];
      const segment = first.provenance.transcript.segments[0];
      if (!target || !segment) throw new Error("Missing fixture");
      const edited = {
        ...target,
        asset: null,
        sourceSegmentIds: [segment.id],
        captionCues: [{ ...segment, text: "Corrected subtitle." }],
        closingDestination: "youtube" as const,
        mediaEdits: {
          ...STUDIO_MEDIA_DEFAULTS,
          captions: captionsEnabled ? ("on" as const) : ("off" as const),
          subtitleSize: "small" as const,
          speechLevel: "louder" as const,
          reduceNoise: true,
          framing: "full-picture" as const,
        },
      };
      const network = vi.spyOn(globalThis, "fetch");
      const result = await generateStudioPackage({
        claim: {
          ...claim,
          package: {
            ...claim.package,
            request: { ...claim.package.request, captions: !captionsEnabled },
            outputs: [edited],
            provenance: first.provenance,
            generation: { outputIds: [target.id], mode: "render" },
          },
        },
        store,
        env,
      });
      expect(network).not.toHaveBeenCalled();
      const output = result.outputs[0];
      expect(output?.startMs).toBe(segment.startMs);
      expect(output?.endMs).toBe(segment.endMs);
      expect(output?.captionCues?.[0]?.text).toBe("Corrected subtitle.");
      expect(output?.mediaEdits).toEqual(edited.mediaEdits);
      expect(output?.closingDestination).toBe("youtube");
      expect(output?.fileVersion).toBe(2);
      if (!captionsEnabled) {
        expect(output?.captions).toEqual([]);
        return;
      }
      const caption = output?.captions[0]?.asset;
      if (!caption) throw new Error("Missing rendered captions");
      expect((await store.readDerivedDescriptor(caption)).toString()).toContain(
        "Corrected subtitle.",
      );
    },
    90000,
  );
  it("accepts JSONB key reordering during a selected-file correction but rejects changed source evidence", async () => {
    const sourceClaim = {
      ...claim,
      package: {
        ...claim.package,
        request: { ...claim.package.request, channels: ["website" as const] },
      },
    };
    const first = await generateStudioPackage({ claim: sourceClaim, store, env });
    const target = first.outputs[0];
    if (!target) throw new Error("Missing fixture output");
    const reordered = JSON.parse(
      JSON.stringify(first.provenance.transcript, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    expect(reordered).toEqual(first.provenance.transcript);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(first.provenance.transcript));
    const correctionClaim = {
      ...sourceClaim,
      package: {
        ...sourceClaim.package,
        outputs: [{ ...target, asset: null }],
        provenance: { ...first.provenance, transcript: reordered },
        generation: { outputIds: [target.id], mode: "render" as const },
      },
    };
    const corrected = await generateStudioPackage({ claim: correctionClaim, store, env });
    expect(corrected.outputs[0]?.id).toBe(target.id);
    reordered.segments[0].text = "Different source evidence.";
    await expect(generateStudioPackage({ claim: correctionClaim, store, env })).rejects.toThrow(
      "SOURCE_DEPENDENCY_CHANGED",
    );
  }, 15000);
  it("retains a coordinator correction and its exact source evidence through regeneration", async () => {
    const first = await generateStudioPackage({
      claim: {
        ...claim,
        package: { ...claim.package, request: { ...claim.package.request, channels: ["website"] } },
      },
      store,
      env,
    });
    const output = first.outputs[0];
    if (!output) throw new Error("Missing output");
    output.body = "Coordinator correction: serve with care.\n\n@sgsswamiji";
    output.sourceSegmentIds = ["two"];
    output.asset = null;
    const result = await generateStudioPackage({
      claim: {
        ...claim,
        package: {
          ...claim.package,
          request: { ...claim.package.request, channels: ["website"] },
          outputs: [output],
        },
      },
      store,
      env,
    });
    expect(result.outputs[0]).toMatchObject({ body: output.body, sourceSegmentIds: ["two"] });
    const asset = result.outputs[0]?.asset;
    if (!asset) throw new Error("Missing rebuilt asset");
    expect((await store.readDerivedDescriptor(asset)).toString()).toContain(
      "Coordinator correction",
    );
  }, 15000);
  it.each(["openai", "gemini", "sarvam"] as const)(
    "refuses unauthorized %s source processing before network and removes scratch",
    async (provider) => {
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external call"));
      await expect(
        generateStudioPackage({
          claim: { ...claim, transcript: provider === "sarvam" ? null : claim.transcript },
          store,
          env: {
            ...env,
            STUDIO_INTELLIGENCE_PROVIDER: provider === "sarvam" ? "local" : provider,
            ...(provider === "sarvam" ? { STUDIO_TRANSCRIPTION_PROVIDER: "sarvam" } : {}),
            STUDIO_OPENAI_API_KEY: "test-not-real",
            STUDIO_OPENAI_MODEL: "test-model",
            STUDIO_GEMINI_API_KEY: "test-not-real",
            STUDIO_GEMINI_MODEL: "gemini-test",
            STUDIO_SARVAM_API_KEY: "test-not-real",
            STUDIO_SARVAM_MODEL: "saaras:v4",
          },
        }),
      ).rejects.toThrow("STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED");
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
    },
  );
  it.each([false, true])(
    "automatically handles long audio=%s and preserves source-bound blog provenance",
    async (longAudio) => {
      if (!claim.transcript) throw new Error("MISSING_TRANSCRIPT");
      const transcript = {
        ...claim.transcript,
        segments: [
          { id: "one", startMs: 0, endMs: 500, text: "Practice kindness." },
          { id: "middle", startMs: 500, endMs: 1500, text: "An intervening explanation." },
          { id: "two", startMs: 1500, endMs: 2000, text: "Serve with care." },
        ],
        recognition: { provider: "sarvam" as const, model: "saaras:v4" },
      };
      const sourceBefore = structuredClone(transcript);
      const transcription = vi
        .spyOn(sarvam, "transcribeSarvamStudioAudio")
        .mockResolvedValue(transcript);
      const execute = studioProcess.executeStudioSource;
      const processes = vi.spyOn(studioProcess, "executeStudioSource");
      if (longAudio)
        processes.mockImplementation(async (input) => {
          const result = await execute(input);
          const output = input.args.at(-1);
          if (output?.endsWith("source.mp3")) {
            const bytes = await readFile(output);
            await writeFile(
              output,
              Buffer.concat([bytes, Buffer.alloc(12 * 1024 * 1024 + 1 - bytes.length)]),
              { mode: 0o600 },
            );
          }
          return result;
        });
      const planned = {
        outputs: [
          {
            channel: "website",
            format: "blog",
            language: "en",
            title: "Kindness in daily service",
            body: "Practice kindness and serve with care.\n\n@sgsswamiji",
            rationale:
              "A complete source-grounded reflection; review original audio before approval.",
            sourceSegmentIds: ["one", "two"],
          },
        ],
        skippedChannels: [],
        translations: [],
      };
      const checks = [
        {
          channel: "website",
          language: "en",
          openingComplete: true,
          endingComplete: true,
          contextComplete: true,
          attributionCorrect: true,
          captionsFaithful: true,
          copySupported: true,
          reason: "The written reflection faithfully summarizes the cited passages.",
        },
      ];
      const response = (value: unknown) =>
        Response.json({
          candidates: [
            {
              finishReason: "STOP",
              content: { role: "model", parts: [{ text: JSON.stringify(value) }] },
            },
          ],
        });
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(response(planned))
        .mockResolvedValueOnce(response({ checks }));
      const result = await generateStudioPackage({
        claim: {
          ...claim,
          transcript: null,
          externalProcessing: { allowed: true, reason: null },
          package: {
            ...claim.package,
            request: { ...claim.package.request, channels: ["website"] },
          },
        },
        store,
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_API_KEY: "synthetic-gemini-secret",
          STUDIO_GEMINI_MODEL: "gemini-synthetic-model",
          STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
          STUDIO_SARVAM_API_KEY: "synthetic-sarvam-secret",
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.outputs[0]?.aiReview).toMatchObject({
        status: "PASSED",
        fileVersion: 1,
        inputMode: "transcript_and_audio",
        checks: checks[0],
      });
      const [url, init] = fetcher.mock.calls[0] ?? [];
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-synthetic-model:generateContent",
      );
      const request = JSON.parse(String(init?.body));
      const parts = request.contents[0].parts;
      expect(JSON.parse(parts[0].text).source.segments).toEqual(transcript.segments);
      const reviewRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
      const audioPart = longAudio ? reviewRequest.contents[0].parts[1] : parts[1];
      if (longAudio) {
        expect(parts).toHaveLength(1); // Full transcript, no oversized inline attachment.
        expect(JSON.parse(reviewRequest.contents[0].parts[0].text).audioAttachment).toMatchObject({
          startMs: 0,
          endMs: 2000,
        });
      }
      expect(audioPart.inlineData.mimeType).toBe("audio/mpeg");
      const audio = Buffer.from(audioPart.inlineData.data, "base64");
      expect(audio.length).toBeGreaterThan(0);
      expect(transcription).toHaveBeenCalledTimes(1);
      if (longAudio) {
        expect(transcription.mock.calls[0]?.[0].bytes.length).toBeGreaterThan(12 * 1024 * 1024);
        expect(audio.length).toBeLessThan(12 * 1024 * 1024);
      } else expect(transcription.mock.calls[0]?.[0].bytes).toEqual(audio);
      expect(processes.mock.calls.filter(([input]) => input.args.includes("-vn"))).toHaveLength(2);
      const audioPath = join(root, "gemini-captured-audio.mp3");
      await writeFile(audioPath, audio, { mode: 0o600 });
      const audioProbe = JSON.parse(
        execFileSync(
          ffprobe,
          ["-v", "error", "-show_streams", "-show_format", "-of", "json", audioPath],
          { encoding: "utf8" },
        ),
      );
      expect(audioProbe.streams).toHaveLength(1);
      expect(audioProbe.streams[0]).toMatchObject({
        codec_type: "audio",
        channels: 1,
        sample_rate: "16000",
      });
      expect(Number(audioProbe.format.duration)).toBeCloseTo(2, 0);
      expect(result.provenance).toMatchObject({
        provider: "gemini",
        model: "gemini-synthetic-model",
        inputMode: "transcript_and_audio",
        transcript,
      });
      expect(result.provenance.transcript.recognition).toEqual({
        provider: "sarvam",
        model: "saaras:v4",
      });
      expect(result.outputs).toHaveLength(1);
      const output = result.outputs[0];
      if (!output?.asset) throw new Error("MISSING_GENERATED_ASSET");
      expect(output).toMatchObject({
        ...planned.outputs[0],
        startMs: null,
        endMs: null,
        aspect: "prose",
        included: true,
      });
      expect(output.warnings).toContain("Machine transcript requires correction and human review.");
      expect(parseStudioAssetDescriptor(output.asset)?.identity).toMatchObject({
        masterId: claim.source.masterId,
        sourceVersionId: claim.source.versionId,
        channel: "website",
        format: "blog",
      });
      expect((await store.readDerivedDescriptor(output.asset)).toString()).toContain(
        "Sri Ganapathy Sachchidananda Swamiji",
      );
      expect((await store.readDerivedDescriptor(output.asset)).toString()).toContain(
        planned.outputs[0]?.body,
      );
      expect(transcript).toEqual(sourceBefore);
      expect(JSON.stringify(result)).not.toContain("synthetic-gemini-secret");
      expect(JSON.stringify(request)).not.toContain(claim.package.createdBy);
      expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
    },
    15000,
  );
  it("does not treat a public readiness flag as authorization to call Gemini without the actual key", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected external call"));
    await expect(
      generateStudioPackage({
        claim: { ...claim, transcript: null, externalProcessing: { allowed: true, reason: null } },
        store,
        env: {
          ...env,
          STUDIO_INTELLIGENCE_PROVIDER: "gemini",
          STUDIO_GEMINI_CONFIGURED: "true",
          STUDIO_GEMINI_MODEL: "gemini-synthetic-model",
          STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
          STUDIO_SARVAM_API_KEY: "synthetic-sarvam-secret",
        },
      }),
    ).rejects.toThrow("STUDIO_INTELLIGENCE_NOT_CONFIGURED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
  }, 15000);
  it.each([0])(
    "rejects a %i-byte Gemini audio attachment before paid transcription",
    async (audioBytes) => {
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external call"));
      const process = vi
        .spyOn(studioProcess, "executeStudioSource")
        .mockImplementation(async (input) => {
          if (input.executable === ffprobe)
            return JSON.stringify({
              format: { duration: "2000" },
              streams: [{ codec_type: "video", width: 320, height: 180 }, { codec_type: "audio" }],
            });
          const output = input.args.at(-1);
          if (!output?.endsWith("source.mp3")) throw new Error("UNEXPECTED_EXTRACTION");
          await writeFile(output, Buffer.alloc(audioBytes), { mode: 0o600 });
          return "";
        });
      await expect(
        generateStudioPackage({
          claim: {
            ...claim,
            transcript: null,
            externalProcessing: { allowed: true, reason: null },
          },
          store,
          env: {
            ...env,
            STUDIO_INTELLIGENCE_PROVIDER: "gemini",
            STUDIO_GEMINI_API_KEY: "synthetic-gemini-secret",
            STUDIO_GEMINI_MODEL: "gemini-synthetic-model",
            STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
            STUDIO_SARVAM_API_KEY: "synthetic-sarvam-secret",
          },
        }),
      ).rejects.toThrow("STUDIO_AUDIO_INVALID_OR_TOO_LARGE");
      expect(fetcher).not.toHaveBeenCalled();
      expect(process).toHaveBeenCalledTimes(2);
      expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
    },
  );
  it.each(["sarvm", "local", " "])(
    "refuses unknown explicit ASR provider '%s' instead of executing the local fallback",
    async (provider) => {
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected external call"));
      await expect(
        generateStudioPackage({
          claim: { ...claim, transcript: null },
          store,
          env: {
            ...env,
            STUDIO_TRANSCRIPTION_PROVIDER: provider,
            STUDIO_WHISPER_COMMAND: "/synthetic/unexpected-local-command",
            STUDIO_TRANSCRIPT_CACHE_ROOT: join(root, "unexpected-cache"),
          },
        }),
      ).rejects.toThrow("STUDIO_TRANSCRIPTION_PROVIDER_UNSUPPORTED");
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(env.STUDIO_SCRATCH_ROOT as string)).toEqual([]);
    },
  );
  it("fails source integrity and canceled subprocesses before rendering", async () => {
    await expect(
      generateStudioPackage({
        claim: {
          ...claim,
          package: {
            ...claim.package,
            source: { ...claim.package.source, sha256: "0".repeat(64) },
          },
        },
        store,
        env,
      }),
    ).rejects.toThrow("SOURCE_INTEGRITY_FAILED");
    const stop = new AbortController();
    stop.abort();
    await expect(
      executeStudioSource({
        executable: ffprobe,
        args: ["-i", "__SOURCE__"],
        sourcePath: join(root, "synthetic.mp4"),
        mimeType: "video/mp4",
        directory: root,
        timeoutMs: 30000,
        signal: stop.signal,
      }),
    ).rejects.toThrow("RENDER_CANCELLED");
  });
  it("refuses a disguised playlist instead of following a referenced source", async () => {
    const path = join(root, "hostile.mp4");
    await writeFile(path, `#EXTM3U\n#EXTINF:1,\nfile://${join(root, "synthetic.mp4")}\n`);
    await expect(
      executeStudioSource({
        executable: ffprobe,
        args: ["-v", "error", "-show_format", "-i", "__SOURCE__"],
        sourcePath: path,
        mimeType: "video/mp4",
        directory: root,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("RENDER_PROCESS_FAILED");
  });
  it("uses only checksum-bound private transcription caches", async () => {
    const cache = join(root, "cache");
    await mkdir(cache, { mode: 0o700 });
    await writeFile(
      join(cache, `${claim.source.sha256}.json`),
      JSON.stringify({ sourceSha256: "incorrect", raw: {} }),
      { mode: 0o600 },
    );
    await expect(
      generateStudioPackage({
        claim: { ...claim, transcript: null },
        store,
        env: { ...env, STUDIO_TRANSCRIPT_CACHE_ROOT: cache },
      }),
    ).rejects.toThrow("STUDIO_CACHE_SOURCE_MISMATCH");
  });
});
describe("caption fidelity", () => {
  it("paginates long native-language cues without dropping any grapheme or changing boundaries", () => {
    const text = "తెలుగు పరీక్ష నమూనా ".repeat(100);
    const pages = studioCaptionPages([{ id: "native", startMs: 500, endMs: 10500, text }]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.text).join("")).toBe(text);
    expect(pages[0]?.startMs).toBe(500);
    expect(pages.at(-1)?.endMs).toBe(10500);
    pages.slice(1).forEach((p, i) => expect(p.startMs).toBe(pages[i]?.endMs));
  });
  it("escapes cue markup and keeps media-relative VTT timing", () => {
    const result = studioVtt(
      [{ id: "a", startMs: 1500, endMs: 2300, text: "A < B & C" }],
      1000,
      3000,
    );
    expect(result).toContain("00:00:00.500 --> 00:00:01.300");
    expect(result).toContain("A &lt; B &amp; C");
  });
});

it("retains transcription and finished files after a later rendering failure without creating versions", async () => {
  const { studioFingerprint } = await import("./studio-checkpoints");
  const saved = new Map<string, { fingerprint: string; value: unknown }>();
  const checkpoints = {
    get: <T>(key: string, fp: string) =>
      saved.get(key)?.fingerprint === fp
        ? (structuredClone(saved.get(key)?.value) as T)
        : undefined,
    set: async (key: string, fingerprint: string, value: unknown) => {
      saved.set(key, { fingerprint, value: structuredClone(value) });
    },
    progress: vi.fn(async () => {}),
  };
  if (!claim.transcript) throw Error("Missing fixture transcript");
  const transcription = vi
    .spyOn(sarvam, "transcribeSarvamStudioAudio")
    .mockResolvedValue(claim.transcript);
  const scoped = {
    ...claim,
    transcript: null,
    externalProcessing: { allowed: true, reason: null },
    package: {
      ...claim.package,
      id: randomUUID(),
      request: { ...claim.package.request, channels: ["x", "website"] as const },
    },
  };
  const sourceClaim = {
    ...scoped,
    package: {
      ...scoped.package,
      request: { ...scoped.package.request, channels: [...scoped.package.request.channels] },
    },
  };
  const environment = {
    ...env,
    STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
    STUDIO_SARVAM_API_KEY: "synthetic",
  };
  const original = store.writeDerivedDescriptor.bind(store);
  let count = 0;
  const writer = vi.spyOn(store, "writeDerivedDescriptor").mockImplementation(async (...args) => {
    if (++count === 2) throw Error("Synthetic render failure");
    return original(...args);
  });
  await expect(
    generateStudioPackage({ claim: sourceClaim, store, env: environment, checkpoints }),
  ).rejects.toThrow("Synthetic render failure");
  const first = structuredClone(saved.get("output:x:en")?.value);
  expect(first).toBeTruthy();
  writer.mockImplementation(original);
  const result = await generateStudioPackage({
    claim: sourceClaim,
    store,
    env: environment,
    checkpoints,
  });
  expect(transcription).toHaveBeenCalledTimes(1);
  expect(result.outputs.find((output) => output.channel === "x")).toEqual(first);
  expect(result.outputs.every((output) => output.fileVersion === 1)).toBe(true);
  expect(studioFingerprint(result.outputs[0])).toBe(studioFingerprint(first));
});

it("supports Bala Swamiji video, image and blog destinations with independent copy and shared portrait media", async () => {
  const artwork = vi.spyOn(mediaRenderer, "studioArtwork");
  const render = vi.spyOn(mediaRenderer, "renderStudioVideo");
  const result = await generateStudioPackage({
    claim: {
      ...claim,
      package: {
        ...claim.package,
        id: randomUUID(),
        request: {
          ...claim.package.request,
          channels: ["youtube", "facebook", "x", "website"],
          sourceBranding: "bala-swamiji",
          youtubeClosing: {
            label: "Gurubhavana ADPT",
            url: "https://www.youtube.com/@gurubhavanaadpt",
          },
        },
      },
    },
    store,
    env,
  });
  expect(result.outputs).toHaveLength(4);
  expect(
    result.outputs.every(
      (o) => o.body.includes("@gurubhavanaadpt") && !o.body.includes("@sgsswamiji"),
    ),
  ).toBe(true);
  expect(render).toHaveBeenCalledTimes(1);
  const videos = result.outputs.filter((o) => ["short", "reel"].includes(o.format));
  expect(videos[0]?.asset?.storageKey).toBe(videos[1]?.asset?.storageKey);
  expect(artwork.mock.calls.find(([i]) => i.format === "post")?.[0].sourceBranding).toBe(
    "bala-swamiji",
  );
  const blog = result.outputs.find((o) => o.channel === "website");
  if (!blog?.asset) throw Error("missing blog");
  const text = (await store.readDerivedDescriptor(blog.asset)).toString();
  expect(text).toContain("Sri Datta Vijayananda Teertha Swamiji");
  expect(text).not.toContain("Sri Ganapathy Sachchidananda Swamiji");
}, 30000);
