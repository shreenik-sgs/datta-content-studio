/**
 * Operator-side bridge from the app's sealed provider store to the isolated Studio worker.
 *
 * Load the SAME core DATABASE_URL / APP_SECRETS_KEY environment as the web app, then:
 *   node --import tsx ops/studio-configured-providers.ts --check
 *   node --import tsx ops/studio-configured-providers.ts --readiness
 *   node --import tsx ops/studio-configured-providers.ts
 *
 * --check and --readiness make no vendor calls and print no credentials. The default
 * starts the fixed Studio entry point with keys only in its process environment.
 * No browser endpoint, plaintext export, or Distribution import of core internals.
 * Provider settings are rechecked every 30 seconds; changes/failures stop the worker.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { unsealFromStorage } from "../packages/db/src/sealed";

type Env = Record<string, string | undefined>;
type Kind = "sarvam" | "gemini" | "openai";

export type StudioConfiguredProviderRow = {
  provider: string;
  kind: string | null;
  active: boolean;
  config: string | null;
  secrets: string | null;
};

export class StudioConfiguredProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StudioConfiguredProviderError";
  }
}

function fail(code: string): never {
  throw new StudioConfiguredProviderError(code);
}

function objectJson(raw: string | null, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(code);
    return value as Record<string, unknown>;
  } catch {
    return fail(code);
  }
}

function selectedProvider(
  rows: readonly StudioConfiguredProviderRow[],
  kind: Kind,
  chosen: string | undefined,
): StudioConfiguredProviderRow {
  const code = `STUDIO_${kind.toUpperCase()}`;
  if (chosen?.trim()) {
    const matching = rows.filter((row) => row.provider === chosen.trim() && row.kind === kind);
    if (matching.length !== 1) return fail(`${code}_PROVIDER_NOT_FOUND`);
    if (!matching[0].active) return fail(`${code}_PROVIDER_DISABLED`);
    return matching[0];
  }
  const active = rows.filter((row) => row.kind === kind && row.active);
  if (active.length === 0) return fail(`${code}_PROVIDER_NOT_CONFIGURED`);
  if (active.length !== 1) return fail(`${code}_PROVIDER_AMBIGUOUS`);
  return active[0];
}

/** Server/operator only: returned secrets belong in a child environment, never JSON/logs. */
export function resolveStudioConfiguredProviderEnv(
  rows: readonly StudioConfiguredProviderRow[],
  env: Env,
): Record<string, string> {
  // Resolve both rows and all models BEFORE decrypting either key.
  const sarvam = selectedProvider(rows, "sarvam", env.STUDIO_SARVAM_PROVIDER);
  const gemini = selectedProvider(rows, "gemini", env.STUDIO_GEMINI_PROVIDER);
  const sarvamConfig = objectJson(sarvam.config, "STUDIO_SARVAM_CONFIG_INVALID");
  const geminiConfig = objectJson(gemini.config, "STUDIO_GEMINI_CONFIG_INVALID");
  const sarvamStoredModel =
    sarvamConfig.asrModel ??
    (typeof sarvamConfig.model === "string" && sarvamConfig.model.startsWith("saaras:")
      ? sarvamConfig.model
      : "saaras:v4");
  const sarvamModel = env.STUDIO_SARVAM_MODEL ?? sarvamStoredModel;
  if (sarvamModel !== "saaras:v4" && sarvamModel !== "saaras:v3")
    return fail("STUDIO_SARVAM_MODEL_UNSUPPORTED");
  // A Studio-specific saved model shares the key without changing the app chat model.
  const geminiModel = env.STUDIO_GEMINI_MODEL ?? geminiConfig.studioModel ?? geminiConfig.model;
  if (
    typeof geminiModel !== "string" ||
    !/^gemini-[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(geminiModel)
  )
    return fail("STUDIO_GEMINI_MODEL_REQUIRED");

  function apiKey(row: StudioConfiguredProviderRow, kind: Kind): string {
    const prefix = `STUDIO_${kind.toUpperCase()}`;
    let plain: string | null;
    try {
      plain = unsealFromStorage(row.secrets, row.provider, env);
    } catch {
      // Never echo a database/client/decryption error, row, or supplied key.
      return fail(`${prefix}_SECRET_UNAVAILABLE`);
    }
    const parsed = objectJson(plain, `${prefix}_SECRET_INVALID`);
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim())
      return fail(`${prefix}_KEY_REQUIRED`);
    const key = parsed.apiKey.trim();
    if (!/^[!-~]+$/.test(key)) return fail(`${prefix}_SECRET_INVALID`);
    return key;
  }

  let fallback: Record<string, string> = {};
  if (env.STUDIO_FALLBACK_ENABLED === "true") {
    const row = selectedProvider(rows, "openai", env.STUDIO_OPENAI_PROVIDER);
    const config = objectJson(row.config, "STUDIO_OPENAI_CONFIG_INVALID");
    const model = env.STUDIO_OPENAI_MODEL ?? config.studioModel ?? config.model;
    if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(model))
      return fail("STUDIO_OPENAI_MODEL_REQUIRED");
    fallback = {
      STUDIO_OPENAI_PROVIDER: row.provider,
      STUDIO_OPENAI_MODEL: model,
      STUDIO_OPENAI_API_KEY: apiKey(row, "openai"),
      STUDIO_FALLBACK_ENABLED: "true",
    };
  }
  return {
    ...fallback,
    STUDIO_SARVAM_PROVIDER: sarvam.provider,
    STUDIO_GEMINI_PROVIDER: gemini.provider,
    STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
    STUDIO_INTELLIGENCE_PROVIDER: "gemini",
    STUDIO_SARVAM_API_KEY: apiKey(sarvam, "sarvam"),
    STUDIO_GEMINI_API_KEY: apiKey(gemini, "gemini"),
    STUDIO_SARVAM_MODEL: sarvamModel,
    STUDIO_GEMINI_MODEL: geminiModel,
    STUDIO_SARVAM_CONFIGURED: "true",
    STUDIO_GEMINI_CONFIGURED: "true",
  };
}

/** Allowlist projection for web readiness. It cannot return any credential or core DB URL. */
export function studioConfiguredProviderReadiness(resolved: Record<string, string>) {
  const keys = [
    "STUDIO_TRANSCRIPTION_PROVIDER",
    "STUDIO_INTELLIGENCE_PROVIDER",
    "STUDIO_SARVAM_MODEL",
    "STUDIO_GEMINI_MODEL",
    "STUDIO_SARVAM_CONFIGURED",
    "STUDIO_GEMINI_CONFIGURED",
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, resolved[key]]));
}

export function studioCoreDatabaseUrl(env: Env): string {
  const databaseUrl = env.STUDIO_CORE_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) return fail("STUDIO_CORE_DATABASE_REQUIRED");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return fail("STUDIO_CORE_DATABASE_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    return fail("STUDIO_CORE_DATABASE_INVALID");
  if (
    env.DISTRIBUTION_HUB_STAGE === "TEST" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return fail("STUDIO_LOCAL_TEST_CORE_DATABASE_REQUIRED");
  return databaseUrl;
}

/** Reads the central configuration for startup/revalidation; never updates the provider store. */
export async function loadStudioConfiguredProviderEnv(env: Env = process.env) {
  const connectionString = studioCoreDatabaseUrl(env);
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    options: "-c default_transaction_read_only=on",
  });
  try {
    const result = await pool.query<StudioConfiguredProviderRow>(
      "SELECT provider, kind, active, config, secrets FROM provider_credentials WHERE kind = ANY($1::text[])",
      [["sarvam", "gemini", "openai"]],
    );
    return resolveStudioConfiguredProviderEnv(result.rows, env);
  } catch (error) {
    if (error instanceof StudioConfiguredProviderError) throw error;
    return fail("STUDIO_CONFIGURED_PROVIDER_READ_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Runtime paths, locale and certificate locations support Node/FFmpeg/local transcription.
// Keep debugging/injection switches (NODE_OPTIONS, NODE_DEBUG, DEBUG) out of the child.
const WORKER_RUNTIME_ENV = new Set([
  "NODE_ENV",
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "DISPLAY",
  "XAUTHORITY",
  "PLAYWRIGHT_BROWSERS_PATH",
]);
// The private S3 asset store uses the AWS SDK's normal credential chain. Explicitly
// retain its supported credential sources and transport settings, not every AWS_* value.
const WORKER_AWS_ENV = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_EC2_METADATA_V1_DISABLED",
  "AWS_CA_BUNDLE",
  "AWS_MAX_ATTEMPTS",
  "AWS_RETRY_MODE",
]);

/**
 * Only the worker's Studio/Distribution settings and the explicit runtime/AWS
 * allowlists cross this boundary. Core DB access, encryption, auth, OAuth, payments,
 * generic provider keys and PG* credentials remain in the bootstrap process.
 */
export function studioConfiguredWorkerEnv(env: Env, resolved: Record<string, string>): Env {
  return Object.fromEntries(
    Object.entries({ ...env, ...resolved }).filter(
      ([key]) =>
        key !== "STUDIO_CORE_DATABASE_URL" &&
        (key.startsWith("STUDIO_") ||
          key.startsWith("DISTRIBUTION_") ||
          WORKER_RUNTIME_ENV.has(key) ||
          WORKER_AWS_ENV.has(key)),
    ),
  );
}

type RevalidationFailure =
  | "STUDIO_CONFIGURED_PROVIDER_CHANGED"
  | "STUDIO_CONFIGURED_PROVIDER_RECHECK_FAILED";

/**
 * Operator-side fail-closed monitor. No credential values or error details reach stop().
 * Return value cancels future checks and ignores an in-flight result after child shutdown.
 */
export function monitorStudioConfiguredProviders(input: {
  env: Env;
  initial: Record<string, string>;
  stop: (reason: RevalidationFailure) => void;
  load?: (env: Env) => Promise<Record<string, string>>;
}) {
  const baseline = { ...input.initial };
  const load = input.load ?? loadStudioConfiguredProviderEnv;
  let disposed = false;
  let checking = false;
  const cancel = () => {
    disposed = true;
    clearInterval(timer);
  };
  async function check() {
    if (disposed || checking) return;
    checking = true;
    let failure: RevalidationFailure | undefined;
    try {
      const current = await load(input.env);
      if (
        Object.keys(current).length !== Object.keys(baseline).length ||
        Object.entries(baseline).some(([key, value]) => current[key] !== value)
      )
        failure = "STUDIO_CONFIGURED_PROVIDER_CHANGED";
    } catch {
      // This includes disabled/ambiguous/missing providers and inaccessible credentials.
      failure = "STUDIO_CONFIGURED_PROVIDER_RECHECK_FAILED";
    } finally {
      checking = false;
    }
    if (failure && !disposed) {
      cancel();
      input.stop(failure);
    }
  }
  const timer = setInterval(() => void check(), 30000);
  timer.unref();
  return cancel;
}

/** Holds a trailing fragment so even a key split across process-output chunks is redacted. */
export function studioSecretRedactor(secrets: readonly string[], write: (text: string) => void) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const longest = Math.max(1, ...values.map((value) => value.length));
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function flush(final: boolean) {
    let safe = "";
    while (pending.length && (final || pending.length >= longest)) {
      const match = values.find((value) => pending.startsWith(value));
      if (match) {
        safe += "[REDACTED]";
        pending = pending.slice(match.length);
      } else {
        safe += pending[0];
        pending = pending.slice(1);
      }
    }
    if (safe) write(safe);
  }
  return {
    write(chunk: Buffer) {
      pending += decoder.write(chunk);
      flush(false);
    },
    end() {
      pending += decoder.end();
      flush(true);
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !["--check", "--readiness"].includes(args[0])))
    return fail("STUDIO_CONFIGURED_PROVIDER_ARGUMENTS_INVALID");
  const resolved = await loadStudioConfiguredProviderEnv();
  if (args[0]) {
    console.info(JSON.stringify(studioConfiguredProviderReadiness(resolved)));
    return;
  }
  const childEnv = studioConfiguredWorkerEnv(process.env, resolved);
  const scrubValues = [
    resolved.STUDIO_SARVAM_API_KEY,
    resolved.STUDIO_GEMINI_API_KEY,
    resolved.STUDIO_OPENAI_API_KEY ?? "",
    process.env.STUDIO_IMPORT_VERIFICATION_KEY ?? "",
    process.env.STUDIO_IMPORT_VERIFICATION_TLS_KEY ?? "",
    process.env.APP_SECRETS_KEY ?? "",
    process.env.DATABASE_URL ?? "",
    process.env.STUDIO_CORE_DATABASE_URL ?? "",
    process.env.DISTRIBUTION_DATABASE_URL ?? "",
  ];
  const stdout = studioSecretRedactor(scrubValues, (text) => process.stdout.write(text));
  const stderr = studioSecretRedactor(scrubValues, (text) => process.stderr.write(text));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../apps/distribution-worker/src/studio-index.ts", import.meta.url)),
    ],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  let configurationFailed = false;
  let forcedStop: NodeJS.Timeout | undefined;
  const cancelMonitor = monitorStudioConfiguredProviders({
    env: process.env,
    initial: resolved,
    stop: (reason) => {
      configurationFailed = true;
      console.error(reason);
      child.kill("SIGTERM");
      // Give the worker's AbortController time to release leases; never leave stale keys running.
      forcedStop = setTimeout(() => child.kill("SIGKILL"), 10000);
      forcedStop.unref();
    },
  });
  const stop = (signal: NodeJS.Signals) => {
    cancelMonitor();
    child.kill(signal);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.stdout.on("data", (chunk: Buffer) => stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.write(chunk));
  const code = await new Promise<number>((done) => {
    child.once("error", () => done(1));
    child.once("close", (status, signal) => done(status ?? (signal === "SIGINT" ? 130 : 143)));
  });
  cancelMonitor();
  if (forcedStop) clearTimeout(forcedStop);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  stdout.end();
  stderr.end();
  if (code !== 0)
    console.error("Studio worker stopped; verify its configuration and safe error codes.");
  // EX_CONFIG asks the supervisor/operator to reload rather than accepting a stale success exit.
  process.exitCode = configurationFailed ? 78 : code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof StudioConfiguredProviderError
        ? error.code
        : "STUDIO_CONFIGURED_PROVIDER_START_FAILED",
    );
    process.exitCode = 1;
  });
}
