import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeAnalysisSchema } from "@satsang/distribution-contracts";
import { validateNativeAnalysis } from "@satsang/distribution-domain";
import type { NativeSemanticAdapter, NativeSemanticInput } from "./native-semantic.js";
export type NativeBatchJob = { id: string; inputPath: string };
type NativeBatchRecord = {
  schemaVersion: 1;
  id: string;
  inputSha256: string;
  status: "COMPLETED" | "FAILED";
  attempts: number;
  durationMs: number;
  at: string;
  error: string | null;
};
async function boundedJson(path: string, max: number): Promise<unknown> {
  const size = (await stat(path)).size;
  if (size > max) throw new Error("NATIVE_BATCH_INPUT_TOO_LARGE");
  const value = await readFile(path);
  if (value.length > max) throw new Error("NATIVE_BATCH_INPUT_TOO_LARGE");
  return JSON.parse(value.toString("utf8"));
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
/** Offline evaluation queue. Each invocation is bounded and resumes completed
 * outputs without a vendor call. Artifacts are proposals only, never approvals.
 * Use one process per output directory; each job has a three-attempt cost cap. */
export async function runNativeBatch(
  jobs: readonly NativeBatchJob[],
  outputDirectory: string,
  adapter: NativeSemanticAdapter,
  limit = 1,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5 ||
    jobs.length > 100 ||
    new Set(jobs.map((j) => j.id)).size !== jobs.length ||
    jobs.some((j) => !/^[a-zA-Z0-9_-]{1,80}$/.test(j.id))
  )
    throw new Error("INVALID_NATIVE_BATCH");
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records: NativeBatchRecord[] = [];
  let processed = 0;
  for (const job of jobs) {
    const input = (await boundedJson(
      resolve(job.inputPath),
      2 * 1024 * 1024,
    )) as NativeSemanticInput;
    const inputSha256 = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const checkpoint = join(directory, `${job.id}.status.json`);
    let previous: NativeBatchRecord | undefined;
    try {
      previous = (await boundedJson(checkpoint, 16384)) as NativeBatchRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      previous &&
      (previous.schemaVersion !== 1 ||
        previous.id !== job.id ||
        previous.inputSha256 !== inputSha256)
    )
      throw new Error("NATIVE_BATCH_SOURCE_CHANGED");
    const output = join(directory, `${job.id}.analysis.json`);
    if (previous?.status === "COMPLETED") {
      const analysis = nativeAnalysisSchema.parse(await boundedJson(output, 2 * 1024 * 1024));
      validateNativeAnalysis(analysis, input.transcript);
      records.push(previous);
      continue;
    }
    if ((previous?.attempts ?? 0) >= 3 || processed >= limit) {
      if (previous) records.push(previous);
      continue;
    }
    processed++;
    const started = Date.now();
    const record: NativeBatchRecord = {
      schemaVersion: 1,
      id: job.id,
      inputSha256,
      status: "FAILED",
      attempts: (previous?.attempts ?? 0) + 1,
      durationMs: 0,
      at: new Date().toISOString(),
      error: "NATIVE_PROCESSING_FAILED",
    };
    // Persist attempt before network work. A crash cannot silently reset the cost budget.
    await atomic(checkpoint, record);
    try {
      const analysis = await adapter.analyze(input, AbortSignal.timeout(65000));
      validateNativeAnalysis(nativeAnalysisSchema.parse(analysis), input.transcript);
      await atomic(output, analysis);
      record.status = "COMPLETED";
      record.error = null;
    } catch {
      /* No provider body, transcript, key or personal data is logged. */
    }
    record.durationMs = Date.now() - started;
    await atomic(checkpoint, record);
    records.push(record);
  }
  return { processed, records };
}
