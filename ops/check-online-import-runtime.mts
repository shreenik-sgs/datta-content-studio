import { checkOnlineImportRuntime } from "../apps/distribution-worker/src/online-import-runtime.js";

try {
  const result = await checkOnlineImportRuntime(process.env.STUDIO_YTDLP_PATH);
  console.info(JSON.stringify({ event: "studio.import.runtime.ready", ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: "studio.import.runtime.failed",
      code:
        error instanceof Error && /^ONLINE_IMPORT_RUNTIME_[A-Z_]+$/.test(error.message)
          ? error.message
          : "ONLINE_IMPORT_RUNTIME_INCOMPLETE",
    }),
  );
  process.exitCode = 1;
}
