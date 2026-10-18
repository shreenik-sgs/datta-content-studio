import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { renderRecipeSchema } from "@satsang/distribution-contracts";
import {
  MAX_MASTER_BYTES,
  type RenderRecipe,
  buildDerivedAssetNames,
  canonicalRenderRecipe,
  parseDerivedAssetKey,
  validateMasterUpload,
} from "@satsang/distribution-domain";

const MAX_DURATION_MS = 600000;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16777216;
const MAX_PROCESS_OUTPUT = 65536;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const seconds = (ms: number) => (ms / 1000).toFixed(3);
function validatedRecipe(input: RenderRecipe): RenderRecipe {
  const recipe = renderRecipeSchema.parse(input);
  if (
    recipe.endMs - recipe.startMs >
      (recipe.template.id === "contained-teaching-v1" ? MAX_DURATION_MS : 120000) ||
    recipe.endMs > 24 * 60 * 60 * 1000
  )
    throw new Error("RENDER_DURATION_LIMIT");
  if (
    !["contained-preview-v1", "contained-teaching-v1"].includes(recipe.template.id) ||
    recipe.template.version !== 1
  )
    throw new Error("UNSUPPORTED_RENDER_TEMPLATE");
  if (recipe.template.id === "contained-teaching-v1" && !recipe.nativeApproval)
    throw new Error("NATIVE_REVIEW_REQUIRED");
  const { placement, ...base } = recipe;
  return { ...base, ...(placement !== undefined ? { placement } : {}) };
}
/** Only descriptor numbers and validated numeric presets enter encoder arguments. */
export function buildLocalRenderArguments(input: RenderRecipe): string[] {
  const recipe = validatedRecipe(input);
  const { width, height } = recipe;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-max_alloc",
    "134217728",
    "-timelimit",
    "120",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "fd",
    "-format_whitelist",
    "mov",
    "-enable_drefs",
    "0",
    "-use_absolute_path",
    "0",
    "-max_pixels",
    String(MAX_INPUT_PIXELS),
    "-f",
    "mov",
    "-fd",
    "3",
    "-ss",
    seconds(recipe.startMs),
    "-i",
    "fd:",
    "-t",
    seconds(recipe.endMs - recipe.startMs),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-threads:v",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-threads:a",
    "1",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-fflags",
    "+bitexact",
    "-metadata",
    "creation_time=1970-01-01T00:00:00Z",
    "-max_muxing_queue_size",
    "1024",
    "-fs",
    String(MAX_OUTPUT_BYTES),
    "-f",
    "mp4",
    "-fd",
    "4",
    "fd:",
  ];
}
function timestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const wholeSeconds = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
export function renderCaptions(input: RenderRecipe): string {
  const recipe = validatedRecipe(input);
  const cues = recipe.captions.map((caption) => {
    const text = caption.text.replace(/\r\n/g, "\n");
    if (
      [...text].some((letter) => {
        const code = letter.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10) || code === 127;
      }) ||
      text.includes("\n\n") ||
      text.startsWith("\n") ||
      text.endsWith("\n")
    )
      throw new Error("UNSUPPORTED_CAPTION_LAYOUT");
    const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `${timestamp(caption.startMs)} --> ${timestamp(caption.endMs)}\n${escaped}\n\n`;
  });
  return `WEBVTT\n\n${cues.join("")}`;
}
export type RenderSource = {
  masterId: string;
  versionId: string;
  storageKey: string;
  /** Durable key preserved when the storage adapter stages a verified local copy. */
  originalStorageKey?: string;
  sha256: string;
  byteSize: number;
  mimeType: "video/mp4";
};
export type RenderedFile = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
};
export type LocalRenderResult = {
  recipeSha256: string;
  sourceSha256: string;
  encoderVersion: string;
  video: RenderedFile;
  captions: RenderedFile | null;
  manifest: RenderedFile;
};
function validateRoot(root: string): void {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root === parse(root).root ||
    root
      .split(sep)
      .some((part) => ["public", "static", "node_modules", ".next", ".git"].includes(part))
  )
    throw new Error("INVALID_RENDER_ROOT");
  let cursor = root;
  while (cursor !== dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) throw new Error("INVALID_RENDER_ROOT");
    cursor = dirname(cursor);
  }
}
async function noSymlinks(path: string): Promise<void> {
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("SYMLINK_REFUSED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function privateDirectory(path: string) {
  await noSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await noSymlinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("PRIVATE_ROOT_PERMISSIONS");
}
/** Each remote render stages media in an isolated directory outside the repository. */
export async function createPrivateRenderScratch(root: string): Promise<string> {
  validateRoot(root);
  await privateDirectory(root);
  return mkdtemp(join(root, ".render-"));
}
async function verifiedSource(root: string, source: RenderSource): Promise<Buffer> {
  const path = join(root, source.storageKey);
  await noSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== source.byteSize || (info.mode & 0o077) !== 0)
      throw new Error("SOURCE_INTEGRITY_FAILED");
    const bytes = Buffer.alloc(source.byteSize);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (offset !== bytes.length || extra.bytesRead || sha(bytes) !== source.sha256)
      throw new Error("SOURCE_INTEGRITY_FAILED");
    validateMasterUpload({
      byteSize: bytes.length,
      mimeType: "video/mp4",
      signature: bytes.subarray(0, 32),
    });
    return bytes;
  } finally {
    await file.close();
  }
}
type ProcessInput = {
  executable: string;
  args: string[];
  cwd: string;
  deadline: number;
  inputFd?: number;
  outputFd?: number;
  signal?: AbortSignal;
  output?: "stdout" | "stderr";
};
async function run(input: ProcessInput): Promise<string> {
  if (input.signal?.aborted) throw new Error("RENDER_CANCELLED");
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) throw new Error("RENDER_TIMEOUT");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, {
      shell: false,
      windowsHide: true,
      cwd: input.cwd,
      env: { PATH: dirname(input.executable), LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe", input.inputFd ?? "ignore", input.outputFd ?? "ignore"],
    });
    let refusal: string | null = null;
    let stdout = "";
    let stderr = "";
    const kill = (reason: string) => {
      refusal ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("RENDER_TIMEOUT"), remaining);
    const cancel = () => kill("RENDER_CANCELLED");
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const clean = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_PROCESS_OUTPUT) {
        stdout = stdout.slice(0, MAX_PROCESS_OUTPUT);
        kill("RENDER_PROCESS_OUTPUT_LIMIT");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_PROCESS_OUTPUT) {
        stderr = stderr.slice(0, MAX_PROCESS_OUTPUT);
        kill("RENDER_PROCESS_OUTPUT_LIMIT");
      }
    });
    child.once("error", (error) => {
      clean();
      reject(new Error("RENDER_PROCESS_UNAVAILABLE", { cause: error }));
    });
    child.once("close", (code) => {
      clean();
      if (refusal) reject(new Error(refusal));
      else if (code !== 0)
        reject(new Error("RENDER_PROCESS_FAILED", { cause: stderr.slice(0, 4000) }));
      else resolvePromise(input.output === "stderr" ? stderr : stdout);
    });
  });
}
export { run as runIsolatedMediaProcess };
type Probe = {
  streams: {
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
  format: { duration: string };
};
async function inspect(
  path: string,
  process: Omit<ProcessInput, "args" | "inputFd" | "outputFd">,
): Promise<Probe> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const result = JSON.parse(
      await run({
        ...process,
        inputFd: file.fd,
        args: [
          "-v",
          "error",
          "-max_alloc",
          "134217728",
          "-max_pixels",
          String(MAX_INPUT_PIXELS),
          "-threads",
          "1",
          "-probesize",
          "5242880",
          "-analyzeduration",
          "5000000",
          "-protocol_whitelist",
          "fd",
          "-format_whitelist",
          "mov",
          "-enable_drefs",
          "0",
          "-use_absolute_path",
          "0",
          "-f",
          "mov",
          "-fd",
          "3",
          "-i",
          "fd:",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,width,height,duration",
          "-of",
          "json",
        ],
      }),
    ) as Probe;
    if (
      !Array.isArray(result.streams) ||
      result.streams.length > 64 ||
      !result.format ||
      !Number.isFinite(Number(result.format.duration))
    )
      throw new Error("INVALID_RENDER_MEDIA");
    return result;
  } finally {
    await file.close();
  }
}
/** Local-only adapter; the caller authorizes the immutable recipe, then rechecks it before release. */
export function createLocalRenderer(options: {
  root: string;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs?: number;
}) {
  const { root, ffmpegPath, ffprobePath } = options;
  validateRoot(root);
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 180000)
    throw new Error("INVALID_RENDER_TIMEOUT");
  if (
    !isAbsolute(ffmpegPath) ||
    basename(ffmpegPath) !== "ffmpeg" ||
    !isAbsolute(ffprobePath) ||
    basename(ffprobePath) !== "ffprobe"
  )
    throw new Error("INVALID_RENDER_EXECUTABLE");
  return {
    /** Call only after a definitive repository rejection, never an uncertain commit. */
    async discard(result: LocalRenderResult): Promise<void> {
      const video = parseDerivedAssetKey(result.video?.storageKey);
      const entries = [
        { file: result.video, kind: "video", maximum: MAX_OUTPUT_BYTES, mime: "video/mp4" },
        {
          file: result.manifest,
          kind: "manifest",
          maximum: 2 * 1024 * 1024,
          mime: "application/json",
        },
        ...(result.captions
          ? [{ file: result.captions, kind: "captions", maximum: 1024 * 1024, mime: "text/vtt" }]
          : []),
      ].map((entry) => ({ ...entry, parsed: parseDerivedAssetKey(entry.file?.storageKey) }));
      if (
        !video ||
        video.kind !== "video" ||
        entries.some(
          ({ file, parsed, kind, maximum, mime }) =>
            !parsed ||
            parsed.directory !== video.directory ||
            parsed.kind !== kind ||
            JSON.stringify(parsed.naming) !== JSON.stringify(video.naming) ||
            file.mimeType !== mime ||
            !Number.isSafeInteger(file.byteSize) ||
            file.byteSize < 1 ||
            file.byteSize > maximum ||
            !/^[a-f0-9]{64}$/.test(file.sha256),
        )
      )
        throw new Error("INVALID_RENDER_RESULT");
      const directory = join(root, video.directory);
      await noSymlinks(directory);
      if (!(await lstat(directory)).isDirectory()) throw new Error("INVALID_RENDER_RESULT");
      const names = await readdir(directory);
      if (
        names.length !== entries.length ||
        names.some((name) => !entries.some((entry) => entry.parsed?.filename === name))
      )
        throw new Error("RENDER_RESULT_CHANGED");
      for (const { file, parsed } of entries) {
        if (!parsed) throw new Error("INVALID_RENDER_RESULT");
        const path = join(directory, parsed.filename);
        await noSymlinks(path);
        const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await descriptor.stat();
          if (
            !stat.isFile() ||
            stat.size !== file.byteSize ||
            (stat.mode & 0o077) !== 0 ||
            sha(await descriptor.readFile()) !== file.sha256
          )
            throw new Error("RENDER_RESULT_CHANGED");
        } finally {
          await descriptor.close();
        }
      }
      const discarded = join(dirname(directory), `.discard-${randomUUID()}`);
      await rename(directory, discarded);
      await rm(discarded, { recursive: true, force: false });
    },
    async render(input: {
      source: RenderSource;
      recipe: RenderRecipe;
      signal?: AbortSignal;
    }): Promise<LocalRenderResult> {
      if (input.signal?.aborted) throw new Error("RENDER_CANCELLED");
      const recipe = validatedRecipe(input.recipe);
      const source = { ...input.source };
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(source.masterId) ||
        source.mimeType !== "video/mp4" ||
        !/^distribution\/masters\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          source.storageKey,
        ) ||
        (source.originalStorageKey !== undefined &&
          !/^distribution\/masters\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            source.originalStorageKey,
          )) ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        source.sha256 !== recipe.sourceSha256 ||
        source.versionId !== recipe.sourceVersionId ||
        !Number.isSafeInteger(source.byteSize) ||
        source.byteSize < 1 ||
        source.byteSize > MAX_MASTER_BYTES
      )
        throw new Error("INVALID_RENDER_SOURCE");
      const captionText = renderCaptions(recipe);
      const derivationId = randomUUID();
      const names = buildDerivedAssetNames({
        masterId: source.masterId,
        sourceVersionId: source.versionId,
        derivationId,
        destination: recipe.placement ?? recipe.channel,
        language: recipe.language,
        aspect: recipe.aspect,
      });
      const deadline = Date.now() + timeoutMs;
      await access(ffmpegPath, constants.X_OK);
      await access(ffprobePath, constants.X_OK);
      await privateDirectory(root);
      await privateDirectory(join(root, "distribution"));
      const renders = join(root, "distribution", "renders");
      await privateDirectory(renders);
      let destinationParent = root;
      for (const component of dirname(names.directory).split("/")) {
        destinationParent = join(destinationParent, component);
        await privateDirectory(destinationParent);
      }
      const bytes = await verifiedSource(root, source);
      const temporary = await mkdtemp(join(renders, ".pending-"));
      try {
        const common = {
          cwd: temporary,
          deadline,
          ...(input.signal ? { signal: input.signal } : {}),
        };
        const encoderVersion =
          (await run({ ...common, executable: ffmpegPath, args: ["-version"] })).split("\n")[0] ??
          "";
        if (!encoderVersion.startsWith("ffmpeg version "))
          throw new Error("INVALID_RENDER_EXECUTABLE");
        const snapshot = join(temporary, "input.mp4");
        await writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
        const sourceInfo = await inspect(snapshot, { ...common, executable: ffprobePath });
        const sourceVideo = sourceInfo.streams.find((stream) => stream.codec_type === "video");
        if (
          !sourceVideo?.width ||
          !sourceVideo.height ||
          sourceVideo.width * sourceVideo.height > MAX_INPUT_PIXELS
        )
          throw new Error("RENDER_PIXEL_LIMIT");
        const sourceDuration = Number(sourceVideo.duration ?? sourceInfo.format.duration);
        if (!Number.isFinite(sourceDuration) || sourceDuration * 1000 + 2 < recipe.endMs)
          throw new Error("SOURCE_SPAN_UNAVAILABLE");
        const videoPath = join(temporary, names.video);
        const sourceFile = await open(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const videoFile = await open(
            videoPath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await run({
              ...common,
              executable: ffmpegPath,
              args: buildLocalRenderArguments(recipe),
              inputFd: sourceFile.fd,
              outputFd: videoFile.fd,
            });
            await videoFile.sync();
          } finally {
            await videoFile.close();
          }
        } finally {
          await sourceFile.close();
        }
        const info = await lstat(videoPath);
        if (info.size < 1 || info.size >= MAX_OUTPUT_BYTES) throw new Error("RENDER_OUTPUT_LIMIT");
        const outputInfo = await inspect(videoPath, { ...common, executable: ffprobePath });
        const video = outputInfo.streams.find((stream) => stream.codec_type === "video");
        const audio = outputInfo.streams.find((stream) => stream.codec_type === "audio");
        const expectedSeconds = (recipe.endMs - recipe.startMs) / 1000;
        const outputDuration = Number(video?.duration ?? outputInfo.format.duration);
        if (
          !Number.isFinite(outputDuration) ||
          !video ||
          video.codec_name !== "h264" ||
          video.width !== recipe.width ||
          video.height !== recipe.height ||
          Math.abs(outputDuration - expectedSeconds) > 0.05 ||
          (sourceInfo.streams.some((stream) => stream.codec_type === "audio") &&
            audio?.codec_name !== "aac")
        )
          throw new Error("RENDER_VALIDATION_FAILED");
        await verifiedSource(root, source);
        if (Date.now() >= deadline) throw new Error("RENDER_TIMEOUT");
        if (input.signal?.aborted) throw new Error("RENDER_CANCELLED");
        const recipeSha256 = sha(canonicalRenderRecipe(recipe));
        const finalKey = names.directory;
        const file = (name: string, bytes: Uint8Array, mimeType: string): RenderedFile => ({
          storageKey: `${finalKey}/${name}`,
          byteSize: bytes.length,
          sha256: sha(bytes),
          mimeType,
        });
        const renderedVideo = file(names.video, await readFile(videoPath), "video/mp4");
        const captions = recipe.captions.length
          ? file(names.captions, Buffer.from(captionText), "text/vtt")
          : null;
        if (captions)
          await writeFile(join(temporary, names.captions), captionText, {
            flag: "wx",
            mode: 0o600,
          });
        const manifestBytes = Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              renderer: "ffmpeg-contained-v1",
              encoderVersion,
              recipeSha256,
              sourceSha256: source.sha256,
              lineage: {
                masterId: source.masterId,
                sourceVersionId: source.versionId,
                derivationId,
                sourceStorageKey: source.originalStorageKey ?? source.storageKey,
                channel: recipe.channel,
                destination: recipe.placement ?? recipe.channel,
              },
              recipe,
              approved: false,
              files: [renderedVideo, ...(captions ? [captions] : [])].map(
                ({ storageKey, ...entry }) => ({ name: basename(storageKey), ...entry }),
              ),
            },
            null,
            2,
          ),
        );
        await writeFile(join(temporary, names.manifest), manifestBytes, {
          flag: "wx",
          mode: 0o600,
        });
        await unlink(snapshot);
        await noSymlinks(destinationParent);
        await rename(temporary, join(root, finalKey));
        return {
          recipeSha256,
          sourceSha256: source.sha256,
          encoderVersion,
          video: renderedVideo,
          captions,
          manifest: file(names.manifest, manifestBytes, "application/json"),
        };
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
