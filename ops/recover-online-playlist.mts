// Optional operator CLI; the Studio UI uses the same recovery engine.
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { recoverPlaylistOnComputer } from "../apps/distribution-worker/src/computer-recovery-runner.js";
import { checkOnlineImportRuntime } from "../apps/distribution-worker/src/online-import-runtime.js";
import {
  COMPUTER_RECOVERY_ERRORS,
  COMPUTER_RECOVERY_ORIGIN,
} from "../packages/distribution-domain/src/index.js";

const bundle = process.argv[2] ?? "";
const username = process.env.STUDIO_RECOVERY_USERNAME;
const password = process.env.STUDIO_RECOVERY_PASSWORD;
const directory = process.env.STUDIO_RECOVERY_DIRECTORY;
if (
  process.env.STUDIO_RECOVERY_ORIGIN !== COMPUTER_RECOVERY_ORIGIN ||
  !/^[0-9a-f-]{36}$/.test(bundle) ||
  !username ||
  !password ||
  !directory
)
  throw Error("RECOVERY_CONFIGURATION_REQUIRED");
await checkOnlineImportRuntime(process.env.STUDIO_YTDLP_PATH);
const folder = resolve(directory, bundle);
await mkdir(folder, { recursive: true, mode: 0o700 });
const lockPath = join(folder, "recovery.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
await lock.close();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  await recoverPlaylistOnComputer({
    bundle,
    username,
    password,
    directory: resolve(directory),
    binary: process.env.STUDIO_YTDLP_PATH,
    signal: controller.signal,
    authorize: async () => {},
    progress: (value) => console.info(JSON.stringify({ at: new Date().toISOString(), ...value })),
  });
  console.info(JSON.stringify({ event: "finished" }));
} catch (error) {
  const code = error instanceof Error ? error.message : "";
  console.info(
    JSON.stringify({
      event: "paused",
      code: Object.hasOwn(COMPUTER_RECOVERY_ERRORS, code) ? code : "RECOVERY_INTERRUPTED",
    }),
  );
  process.exitCode = 1;
} finally {
  await rm(lockPath, { force: true });
}
