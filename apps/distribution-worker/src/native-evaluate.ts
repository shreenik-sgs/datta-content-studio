import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type NativeBatchJob, runNativeBatch } from "./native-batch.js";
import { createOpenAiNativeSemanticAdapter } from "./native-semantic.js";
async function main() {
  const [manifestPath, outputPath, limitText = "1"] = process.argv.slice(2);
  if (!manifestPath || !outputPath)
    throw new Error("Usage: pnpm native:evaluate manifest.json output-directory [1..5]");
  if ((await stat(manifestPath)).size > 65536) throw new Error("INVALID_NATIVE_MANIFEST");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion: number;
    jobs: NativeBatchJob[];
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.jobs))
    throw new Error("INVALID_NATIVE_MANIFEST");
  const adapter = createOpenAiNativeSemanticAdapter({
    apiKey: process.env.NATIVE_OPENAI_API_KEY ?? "",
    model: process.env.NATIVE_OPENAI_MODEL ?? "",
    contractApproval: process.env.NATIVE_PROVIDER_CONTRACT_APPROVAL ?? "",
    retentionApproval: process.env.NATIVE_PROVIDER_RETENTION_APPROVAL ?? "",
  });
  const result = await runNativeBatch(
    manifest.jobs,
    resolve(outputPath),
    adapter,
    Number(limitText),
  );
  for (const record of result.records)
    console.info(JSON.stringify({ event: "distribution.native.processing", ...record }));
  if (result.records.some((r) => r.status === "FAILED")) process.exitCode = 1;
}
main().catch(() => {
  console.error(
    JSON.stringify({
      event: "distribution.native.processing.failure",
      error: "NATIVE_EVALUATION_UNAVAILABLE",
    }),
  );
  process.exitCode = 1;
});
