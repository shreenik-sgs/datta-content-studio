// The long-running Hub preview must not use next dev: React's development
// async-operation tracker exhausted its Map on 2026-10-11. Serve a compiled
// local build instead. Production mode is a runtime choice, not a deployment.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.argv[2];
if (!configPath) throw new Error("Supply the local Hub config.json path");
const config = JSON.parse(readFileSync(configPath, "utf8"));
for (const key of ["DATABASE_URL", "DISTRIBUTION_DATABASE_URL"]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(config[key]).hostname))
    throw new Error("This launcher is restricted to local databases");
}
if (config.DISTRIBUTION_HUB_STAGE !== "TEST" || config.STUDIO_PUBLISHING_ENABLED !== "false")
  throw new Error("Local TEST configuration with publishing disabled is required");
const app = path.join(root, "apps/web");
const dist = config.CORE_PREVIEW_DIST_DIR ?? ".next-core-hub-stable-oct11";
if (!/^\.next-[a-zA-Z0-9_-]+$/.test(dist)) throw new Error("Invalid local build directory");
if (!existsSync(path.join(app, dist, "BUILD_ID")))
  throw new Error("Build the stable local core first");
const child = spawn(
  process.execPath,
  [path.join(app, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3020"],
  {
    cwd: app,
    env: { ...process.env, ...config, NODE_ENV: "production", NEXT_DIST_DIR: dist },
    stdio: "inherit",
  },
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
