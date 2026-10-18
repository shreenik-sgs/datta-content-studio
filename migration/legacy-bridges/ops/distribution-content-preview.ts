/** Local-only acceptance runner. It creates watermarked review drafts, never approvals or sends. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import {
  type ContentPackContext,
  STATIC_POST_DIMENSIONS,
  escapeContentPackText as esc,
  renderBlogPreview,
  renderStaticPost,
  renderVerticalVideoBackdrop,
} from "../apps/distribution-worker/src/content-pack-templates";
import { normalizeLocalWhisperRecognition } from "../apps/distribution-worker/src/local-recognition";
import {
  previewFileSha256,
  probePreviewMedia,
  renderPreviewClip,
} from "../apps/distribution-worker/src/preview-media";
import { contentPreviewPackSchema } from "../packages/distribution-contracts/src/content-pack";
import {
  type ContentPreviewPack,
  type PreviewArtifactAspect,
  type PreviewArtifactKind,
  type PreviewDestination,
  canonicalPreviewBrandProfile,
  previewArtifactFilename,
  validateContentPreviewPack,
} from "../packages/distribution-domain/src/content-pack";
import {
  NATIVE_LANGUAGES,
  type NativeLanguage,
} from "../packages/distribution-domain/src/native-intelligence";
const exec = promisify(execFile);
const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
const stamp = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const at = (a: ContentPreviewPack["clips"][number]["attribution"]) =>
  a.quotedSpeaker ? `${a.quotedSpeaker}'s ${a.subject}` : a.subject;
async function main() {
  const [mode, planFile, masterFile, logoFile, whisperFile, metadataFile, destination] =
    process.argv.slice(2);
  if (
    mode !== "--test-preview" ||
    !planFile ||
    !masterFile ||
    !logoFile ||
    !whisperFile ||
    !metadataFile ||
    !destination
  )
    throw new Error(
      "Usage: tsx ops/distribution-content-preview.ts --test-preview plan.json master.mp4 logo.jpg whisper.json metadata.json output-directory",
    );
  const plan = contentPreviewPackSchema.parse(JSON.parse(await readFile(planFile, "utf8")));
  if (!NATIVE_LANGUAGES.includes(plan.source.language as NativeLanguage))
    throw new Error("UNSUPPORTED_PREVIEW_LANGUAGE");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  if (
    typeof metadata.description !== "string" ||
    hashText(metadata.description) !== plan.source.descriptionSha256 ||
    metadata.id !== plan.source.id ||
    metadata.title !== plan.source.title ||
    metadata.webpage_url !== plan.source.url
  )
    throw new Error("PREVIEW_DESCRIPTION_MISMATCH");
  validateContentPreviewPack(plan);
  const sourcePath = resolve(masterFile);
  const logoPath = resolve(logoFile);
  const output = resolve(destination);
  const sourceSha256 = await previewFileSha256(sourcePath);
  if (
    sourceSha256 !== plan.source.sha256 ||
    (await previewFileSha256(logoPath)) !== plan.brand.logoSha256 ||
    hashText(canonicalPreviewBrandProfile(plan.brand)) !== plan.brand.profileSha256 ||
    (await previewFileSha256(resolve(whisperFile))) !== plan.source.transcriptSha256
  )
    throw new Error("PREVIEW_INPUT_HASH_MISMATCH");
  const sourceProbe = await probePreviewMedia(sourcePath);
  if (
    !Number.isFinite(Number(sourceProbe.format.duration)) ||
    Number(sourceProbe.format.duration) <= 0 ||
    Math.abs(Number(sourceProbe.format.duration) * 1000 - plan.source.durationMs) > 50 ||
    !sourceProbe.streams.some((s) => s.codec_type === "audio")
  )
    throw new Error("PREVIEW_MASTER_MISMATCH");
  const raw = JSON.parse(await readFile(whisperFile, "utf8"));
  const normalized = normalizeLocalWhisperRecognition(
    {
      raw,
      sourceSha256,
      durationMs: plan.source.durationMs,
      language: plan.source.language as NativeLanguage,
      model: "mlx-community/whisper-large-v3-mlx",
      timingMode: "segment_only",
    },
    {
      versionId: plan.source.id,
      sha256: sourceSha256,
      transcriptId: `${plan.source.id}-whisper-v1`,
    },
  );
  const expectedSegments = normalized.transcript.segments.map((s) => ({
    id: s.id,
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.originalText,
    language: plan.source.language,
    provenance: "machine_transcript",
  }));
  if (JSON.stringify(plan.segments) !== JSON.stringify(expectedSegments))
    throw new Error("PREVIEW_TRANSCRIPT_MISMATCH");
  await mkdir(output, { mode: 0o700 }); // New immutable run directory; never silently overwrite.
  await chmod(output, 0o700);
  for (const folder of ["videos", "posts", "blogs", "copy", "evidence", "layouts"])
    await mkdir(join(output, folder), { mode: 0o700 });
  const save = async (name: string, data: string | Uint8Array) =>
    writeFile(join(output, name), data, { mode: 0o600, flag: "wx" });
  await save("evidence/native-recognition.json", JSON.stringify(normalized, null, 2));
  await save("evidence/transcript-raw.json", await readFile(whisperFile));
  await save("evidence/content-plan.json", JSON.stringify(plan, null, 2));
  await save(
    "evidence/source-metadata.json",
    JSON.stringify(
      {
        id: metadata.id,
        title: metadata.title,
        channel: metadata.channel,
        channel_url: metadata.channel_url,
        description: metadata.description,
        upload_date: metadata.upload_date,
      },
      null,
      2,
    ),
  );
  await save("evidence/source-probe.json", JSON.stringify(sourceProbe, null, 2));
  await copyFile(logoPath, join(output, "evidence/ashrama-emblem.jpg"));
  const profile = {
    ashramaName: plan.brand.name,
    speakerName: plan.brand.speaker,
    logoDataUrl: `data:image/jpeg;base64,${(await readFile(logoPath)).toString("base64")}`,
  };
  const artifacts: {
    id: string;
    file: string;
    sha256: string;
    byteSize: number;
    channel: PreviewDestination;
    kind: PreviewArtifactKind;
    language: string;
    aspect: PreviewArtifactAspect;
    masterId: string;
    masterSha256: string;
    masterUrl: string;
    sourceClipIds: string[];
    sourceRanges: { clipId: string; startMs: number; endMs: number; segmentIds: string[] }[];
    posterFile?: string;
    media?: unknown;
  }[] = [];
  const name = (
    channel: PreviewDestination,
    kind: PreviewArtifactKind,
    language: string,
    aspect: PreviewArtifactAspect,
    artifactId: string,
    extension: "mp4" | "png" | "html" | "md" | "txt",
  ) =>
    previewArtifactFilename({
      sourceId: plan.source.id,
      sourceSha256,
      channel,
      kind,
      language,
      aspect,
      artifactId,
      extension,
    });
  const channelsFor = (id: string) => plan.platforms.filter((p) => p.assetIds.includes(id));
  const clipIdsFor = (ids: string[]) => [
    ...new Set(
      ids.flatMap((id) => {
        if (plan.clips.some((clip) => clip.id === id)) return [id];
        const post = plan.posts.find((post) => post.id === id);
        if (post) return [post.sourceClipId];
        return plan.blogs.find((blog) => blog.id === id)?.sourceClipIds ?? [];
      }),
    ),
  ];
  if ([...plan.clips, ...plan.posts, ...plan.blogs].some((asset) => !channelsFor(asset.id).length))
    throw new Error("PREVIEW_ARTIFACT_DESTINATION_REQUIRED");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.route("http://**/*", (route) => route.abort());
  await page.route("https://**/*", (route) => route.abort());
  const rasterize = async (html: string, file: string, width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await page.setContent(html);
    await page.screenshot({ path: join(output, file), animations: "disabled" });
    await chmod(join(output, file), 0o600);
  };
  const record = async (
    id: string,
    file: string,
    channel: PreviewDestination,
    kind: PreviewArtifactKind,
    language: string,
    aspect: PreviewArtifactAspect,
    sourceClipIds: string[],
    media?: unknown,
    posterFile?: string,
  ) => {
    if (artifacts.some((artifact) => artifact.file.toLowerCase() === file.toLowerCase()))
      throw new Error("PREVIEW_ARTIFACT_NAME_COLLISION");
    artifacts.push({
      id,
      file,
      channel,
      kind,
      language,
      aspect,
      masterId: plan.source.id,
      masterSha256: sourceSha256,
      masterUrl: plan.source.url,
      sourceClipIds,
      sourceRanges: sourceClipIds.map((clipId) => {
        const clip = plan.clips.find((item) => item.id === clipId);
        if (!clip) throw new Error("MISSING_SOURCE_CLIP");
        return { clipId, startMs: clip.startMs, endMs: clip.endMs, segmentIds: clip.segmentIds };
      }),
      sha256: await previewFileSha256(join(output, file)),
      byteSize: (await stat(join(output, file))).size,
      ...(media ? { media } : {}),
      ...(posterFile ? { posterFile } : {}),
    });
  };
  const context = (
    item: {
      title: string;
      summary: string;
      attribution: ContentPreviewPack["clips"][number]["attribution"];
    },
    clip: ContentPreviewPack["clips"][number],
  ): ContentPackContext => ({
    episodeTitle: plan.source.displayTitle,
    headline: item.title,
    summary: item.summary,
    attribution: at(item.attribution),
    sourceLabel: `${stamp(clip.startMs)}–${stamp(clip.endMs)} · ${({ te: "Telugu", kn: "Kannada", ta: "Tamil" } as Record<string, string>)[plan.source.language] ?? plan.source.language} original audio`,
  });
  try {
    for (const clip of plan.clips) {
      console.info(`Rendering ${clip.id}`);
      const backdrop = renderVerticalVideoBackdrop({ profile, context: context(clip, clip) });
      await save(`layouts/${clip.id}.html`, backdrop);
      await rasterize(backdrop, `layouts/${clip.id}.png`, 1080, 1920);
      const rendered = new Map<string, { file: string; poster: string; media: unknown }>();
      for (const { channel } of channelsFor(clip.id)) {
        const size = channel === "x" ? "x" : "vertical";
        const preferred = channel === "facebook" || channel === "instagram" ? "reel" : "short";
        const kind = clip.formats.includes(preferred) ? preferred : clip.formats[0];
        if (!kind) throw new Error("MISSING_CLIP_FORMAT");
        const file = `videos/${name(channel, kind, plan.source.language, "9:16", clip.id, "mp4")}`;
        const poster = `videos/${name(channel, "poster", plan.source.language, "9:16", clip.id, "png")}`;
        const prior = rendered.get(size);
        if (prior) {
          await copyFile(join(output, prior.file), join(output, file), constants.COPYFILE_EXCL);
          await copyFile(join(output, prior.poster), join(output, poster), constants.COPYFILE_EXCL);
          await record(
            clip.id,
            file,
            channel,
            kind,
            plan.source.language,
            "9:16",
            [clip.id],
            prior.media,
            poster,
          );
          await record(clip.id, poster, channel, "poster", plan.source.language, "9:16", [clip.id]);
          continue;
        }
        await renderPreviewClip({
          world: "TEST",
          publishAllowed: false,
          sourcePath,
          sourceSha256,
          backdropPath: join(output, `layouts/${clip.id}.png`),
          backdropSha256: await previewFileSha256(join(output, `layouts/${clip.id}.png`)),
          outputPath: join(output, file),
          startMs: clip.startMs,
          endMs: clip.endMs,
          durationMs: plan.source.durationMs,
          size,
        });
        const media = await probePreviewMedia(join(output, file));
        const expected = size === "x" ? [720, 1280] : [1080, 1920];
        const video = media.streams.find((s) => s.codec_type === "video");
        if (
          video?.codec_name !== "h264" ||
          video?.r_frame_rate !== "30/1" ||
          !Number.isFinite(Number(media.format.duration)) ||
          video?.width !== expected[0] ||
          video?.height !== expected[1] ||
          !media.streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac") ||
          Math.abs(Number(media.format.duration) * 1000 - (clip.endMs - clip.startMs)) > 100
        )
          throw new Error("RENDER_ACCEPTANCE_FAILED");
        await exec(
          "ffmpeg",
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-ss",
            "0.2",
            "-i",
            join(output, file),
            "-frames:v",
            "1",
            "-update",
            "1",
            join(output, poster),
          ],
          { timeout: 15000 },
        );
        await record(
          clip.id,
          file,
          channel,
          kind,
          plan.source.language,
          "9:16",
          [clip.id],
          media,
          poster,
        );
        await record(clip.id, poster, channel, "poster", plan.source.language, "9:16", [clip.id]);
        rendered.set(size, { file, poster, media });
      }
    }
    for (const post of plan.posts) {
      const clip = plan.clips.find((c) => c.id === post.sourceClipId);
      if (!clip) throw new Error("MISSING_POST_CLIP");
      const still = `evidence/${post.id}-source.png`;
      await exec(
        "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-n",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov",
          "-enable_drefs",
          "0",
          "-use_absolute_path",
          "0",
          "-f",
          "mov",
          "-ss",
          String((clip.startMs + Math.min(2000, (clip.endMs - clip.startMs) / 2)) / 1000),
          "-i",
          sourcePath,
          "-frames:v",
          "1",
          "-update",
          "1",
          join(output, still),
        ],
        { timeout: 15000 },
      );
      const sourceFrameDataUrl = `data:image/png;base64,${(await readFile(join(output, still))).toString("base64")}`;
      for (const aspect of ["4:5", "1:1", "16:9"] as const) {
        const html = renderStaticPost({
          profile,
          context: context(post, clip),
          aspect,
          sourceFrameDataUrl,
        });
        const { width, height } = STATIC_POST_DIMENSIONS[aspect];
        let rendered: string | undefined;
        for (const { channel } of channelsFor(post.id)) {
          const file = `posts/${name(channel, "post", "en", aspect, post.id, "png")}`;
          if (rendered)
            await copyFile(join(output, rendered), join(output, file), constants.COPYFILE_EXCL);
          else {
            await rasterize(html, file, width, height);
            rendered = file;
          }
          await record(post.id, file, channel, "post", "en", aspect, [post.sourceClipId]);
        }
      }
    }
    for (const blog of plan.blogs) {
      const clip = plan.clips.find((c) => c.id === blog.sourceClipIds[0]);
      if (!clip) throw new Error("MISSING_BLOG_CLIP");
      const post = plan.posts.find((p) => p.sourceClipId === clip.id);
      if (!post) throw new Error("MISSING_BLOG_IMAGE");
      const sourceFrameDataUrl = `data:image/png;base64,${(await readFile(join(output, `evidence/${post.id}-source.png`))).toString("base64")}`;
      const md = `# ${blog.title}\n\n${plan.brand.name}\n${plan.brand.speaker}\n\nTEST PREVIEW — Editorial summary; review required.\n\n${blog.dek}\n\n${blog.paragraphs.join("\n\n")}\n\nSource: [${plan.source.title}](${plan.source.url})\n\nSource passages: ${blog.sourceClipIds
        .map((id) => {
          const c = plan.clips.find((x) => x.id === id);
          return c ? `${stamp(c.startMs)}–${stamp(c.endMs)}` : "";
        })
        .join(", ")}.\n\nJaya Guru Datta\n`;
      let html = renderBlogPreview({
        profile,
        context: {
          ...context({ title: blog.title, summary: blog.dek, attribution: blog.attribution }, clip),
          episodeTitle: plan.source.displayTitle,
        },
        sourceFrameDataUrl,
        sections: [
          { heading: "A reflection on the episode", paragraphs: blog.paragraphs },
          {
            heading: "Watch the full discourse",
            paragraphs: [
              `${plan.source.title} — ${plan.source.url}`,
              "This is an editorial summary and reflection, not a verbatim quotation or an approved translation.",
            ],
          },
        ],
      });
      html = html.replace(
        "</body>",
        `<p style="padding:24px;text-align:center"><a href="${esc(plan.source.url)}" rel="noreferrer">Watch the source discourse</a></p></body>`,
      );
      for (const { channel } of channelsFor(blog.id)) {
        for (const [extension, bytes] of [
          ["html", html],
          ["md", md],
        ] as const) {
          const file = `blogs/${name(channel, "blog", "en", "prose", blog.id, extension)}`;
          await save(file, bytes);
          await record(blog.id, file, channel, "blog", "en", "prose", blog.sourceClipIds);
        }
      }
    }
  } finally {
    await browser.close();
  }
  const copyFiles = new Map<PreviewDestination, string>();
  for (const p of plan.platforms) {
    const file = `copy/${name(p.channel, "copy", "en", "prose", "platform-copy", "txt")}`;
    const suggested = artifacts.filter(
      (artifact) => artifact.channel === p.channel && artifact.kind !== "poster",
    );
    await save(
      file,
      `${plan.brand.name}\n${plan.brand.speaker}\nTEST PREVIEW — Review required\n\n${p.title}\n\n${p.body}\n\nMaster: ${plan.source.id}\nSource: ${plan.source.url}\nSource SHA-256: ${sourceSha256}\nChannel: ${p.channel}\n\nSuggested assets:\n${suggested.map((artifact) => artifact.file).join("\n")}\nPlacement: ${p.recommendation}\n`,
    );
    await record("platform-copy", file, p.channel, "copy", "en", "prose", clipIdsFor(p.assetIds));
    copyFiles.set(p.channel, file);
  }
  if (
    (await previewFileSha256(sourcePath)) !== sourceSha256 ||
    (await previewFileSha256(logoPath)) !== plan.brand.logoSha256
  )
    throw new Error("PREVIEW_INPUT_CHANGED");
  const manifest = {
    schemaVersion: 2,
    world: "TEST",
    publishAllowed: false,
    status: "DRAFT_REVIEW_REQUIRED",
    source: plan.source,
    brand: plan.brand,
    createdAt: new Date().toISOString(),
    artifacts,
    validation: {
      sourceAndBrandHashes: true,
      allRequiredFormats: true,
      allFivePlatforms: true,
      videoCodecDurationDimensions: true,
      humanEditorialApproval: false,
      productionProviderAdoption: false,
    },
    recognitionWarnings: normalized.warnings,
    generation: {
      asr: "Local MLX Whisper large-v3",
      copyAndSelection: "Codex-assisted editorial plan",
      orchestration: "local acceptance CLI",
      nativeReview: null,
      captionPolicy:
        "No unreviewed word-for-word captions burned into outputs; English text is a labelled editorial summary.",
    },
  };
  await save("manifest.json", JSON.stringify(manifest, null, 2));
  const cards = artifacts
    .filter(
      (artifact) => !["copy", "poster"].includes(artifact.kind) && !artifact.file.endsWith(".md"),
    )
    .map(
      (a) =>
        `<article><h3>${esc(a.channel)} · ${esc(a.id)}</h3><p>${esc(a.kind)} · Master ${esc(a.masterId)}</p>${a.file.endsWith(".mp4") ? `<video controls preload="metadata" poster="${esc(a.posterFile ?? "")}" aria-label="${esc(a.id)} video review" src="${esc(a.file)}"></video>` : a.file.endsWith(".png") ? `<img loading="lazy" src="${esc(a.file)}" alt="${esc(a.id)} — branded test preview">` : `<p><a href="${esc(a.file)}">Read this blog</a></p>`}<a href="${esc(a.file)}" download>Open / save ${esc(a.file.split("/").at(-1) ?? a.id)}</a></article>`,
    )
    .join("");
  await save(
    "index.html",
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'"><title>${esc(plan.source.displayTitle)} · Ashrama content review</title><style>body{margin:0;background:#fffaf2;color:#291f22;font:17px/1.65 system-ui}header,main{max-width:1240px;margin:auto;padding:36px}header{border-bottom:1px solid #e1d3bd}h1,h2,h3{font-family:Georgia,serif;color:#481b2b}h1{font-size:42px;line-height:1.2}a{color:#8d2549}nav{display:flex;gap:22px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}article{background:white;padding:20px;border:1px solid #e1d3bd;border-radius:12px}video,img{max-width:100%;max-height:580px;display:block;margin:auto}.badge{font-size:13px;letter-spacing:.12em;font-weight:700}td,th{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid #e1d3bd}table{width:100%;border-collapse:collapse;table-layout:fixed;overflow-wrap:anywhere}.copy{white-space:pre-wrap;font-size:15px}article{min-width:0;overflow-wrap:anywhere}@media(max-width:600px){header,main{padding:20px}h1{font-size:32px}.grid{grid-template-columns:minmax(0,1fr)}td,th{padding:8px}nav{gap:12px}}</style></head><body><header><p class="badge">TEST PREVIEW · EDITORIAL REVIEW REQUIRED</p><h1>${esc(plan.brand.name)}<br>One discourse. Multiple ways to reflect.</h1><p>${esc(plan.source.title)}</p><p>Original source audio, complete source framing, Ashrama identification and source-linked editorial summaries. These files have not been published or marked approved.</p><nav><a href="#formats">Review formats</a><a href="#platforms">Platform suggestions</a><a href="manifest.json">Validation manifest</a><a href="${esc(plan.source.url)}">Original master</a></nav></header><main><h2 id="formats">Created artifacts</h2><div class="grid">${cards}</div><h2 id="platforms">Suggested placement</h2><table><thead><tr><th>Platform</th><th>Recommendation</th><th>Copy</th></tr></thead><tbody>${plan.platforms.map((p) => `<tr><td>${esc(p.channel)}</td><td>${esc(p.recommendation)}</td><td><a href="${esc(copyFiles.get(p.channel) ?? "")}">Open prepared copy</a></td></tr>`).join("")}</tbody></table>${plan.platforms.map((p) => `<h3>${esc(p.channel)} · ${esc(p.title)}</h3><p class="copy">${esc(p.body)}</p>`).join("")}<h2>Review notes</h2><p>Speech recognition ran locally with Whisper large-v3. English copy is an assistant-generated editorial summary, not an official subtitle translation. Verify Telugu wording, source cut boundaries and the proposed Ashrama emblem before publication. No approval records or production settings were changed.</p></main></body></html>`,
  );
  const files = [];
  for (const name of (await readdir(output, { recursive: true })).sort()) {
    const path = join(output, name);
    if (!(await stat(path)).isFile()) continue;
    await chmod(path, 0o600);
    files.push({
      file: name,
      sha256: await previewFileSha256(path),
      byteSize: (await stat(path)).size,
    });
  }
  await save(
    "integrity.json",
    JSON.stringify({ algorithm: "sha256", excludes: ["integrity.json"], files }, null, 2),
  );
  console.info(JSON.stringify({ output, artifacts: artifacts.length, status: manifest.status }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
