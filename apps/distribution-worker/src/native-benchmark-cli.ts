import { readFile, stat, writeFile } from "node:fs/promises";
import { type NativeBakeoffSample, nativeBakeoff } from "@satsang/distribution-domain";
async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("INPUT_AND_OUTPUT_REQUIRED");
  if ((await stat(input)).size > 2 * 1024 * 1024) throw new Error("CORPUS_TOO_LARGE");
  const manifest = JSON.parse(await readFile(input, "utf8")) as {
    schemaVersion: number;
    provider: string;
    model: string;
    samples: NativeBakeoffSample[];
  };
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.provider?.trim() ||
    !manifest.model?.trim() ||
    !Array.isArray(manifest.samples) ||
    manifest.samples.length > 1000
  )
    throw new Error("INVALID_CORPUS");
  const report = {
    schemaVersion: 1,
    provider: manifest.provider,
    model: manifest.model,
    generatedAt: new Date().toISOString(),
    ...nativeBakeoff(manifest.samples),
  };
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.info(
    JSON.stringify({
      event: "distribution.native.benchmark",
      corpus: report.corpus,
      realCorpusReady: report.realCorpusReady,
      releaseApproved: false,
    }),
  );
}
main().catch(() => {
  console.error("NATIVE_BENCHMARK_INVALID");
  process.exitCode = 1;
});
