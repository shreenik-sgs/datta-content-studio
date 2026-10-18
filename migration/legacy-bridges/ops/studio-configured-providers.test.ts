import { afterEach, describe, expect, it, vi } from "vitest";
import { sealForStorage } from "../packages/db/src/sealed";
import {
  type StudioConfiguredProviderRow,
  loadStudioConfiguredProviderEnv,
  monitorStudioConfiguredProviders,
  resolveStudioConfiguredProviderEnv,
  studioConfiguredProviderReadiness,
  studioConfiguredWorkerEnv,
  studioCoreDatabaseUrl,
  studioSecretRedactor,
} from "./studio-configured-providers";

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), options: vi.fn() }));
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: unknown) {
      database.options(options);
    }
    query = database.query;
    end = database.end;
  },
}));

const sealingEnv = { APP_SECRETS_KEY: "studio-test-only-sealing-secret-at-least-32-chars" };
const sarvamKey = "test-only-sarvam-key";
const geminiKey = "test-only-gemini-key";
function rows(): StudioConfiguredProviderRow[] {
  return [
    {
      provider: "sarvam-chat",
      kind: "sarvam",
      active: true,
      config: JSON.stringify({ model: "sarvam-105b" }),
      secrets: sealForStorage(JSON.stringify({ apiKey: sarvamKey }), "sarvam-chat", sealingEnv),
    },
    {
      provider: "gemini-chat",
      kind: "gemini",
      active: true,
      config: JSON.stringify({ model: "gemini-3.5-flash-lite" }),
      secrets: sealForStorage(JSON.stringify({ apiKey: geminiKey }), "gemini-chat", sealingEnv),
    },
  ];
}

describe("Studio operator-side reuse of configured provider credentials", () => {
  it("opens existing sealed provider keys and keeps the stored Gemini model", () => {
    expect(resolveStudioConfiguredProviderEnv(rows(), sealingEnv)).toEqual({
      STUDIO_SARVAM_PROVIDER: "sarvam-chat",
      STUDIO_GEMINI_PROVIDER: "gemini-chat",
      STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
      STUDIO_INTELLIGENCE_PROVIDER: "gemini",
      STUDIO_SARVAM_API_KEY: sarvamKey,
      STUDIO_GEMINI_API_KEY: geminiKey,
      STUDIO_SARVAM_MODEL: "saaras:v4",
      STUDIO_GEMINI_MODEL: "gemini-3.5-flash-lite",
      STUDIO_SARVAM_CONFIGURED: "true",
      STUDIO_GEMINI_CONFIGURED: "true",
    });
  });

  it("uses the finalized Studio models while retaining the shared chat configuration", () => {
    const configured = rows();
    configured[0].config = JSON.stringify({ model: "sarvam-105b", asrModel: "saaras:v4" });
    configured[1].config = JSON.stringify({
      model: "gemini-3.5-flash-lite",
      studioModel: "gemini-3.5-flash",
    });
    const before = structuredClone(configured);
    const resolved = resolveStudioConfiguredProviderEnv(configured, sealingEnv);
    expect(studioConfiguredProviderReadiness(resolved)).toMatchObject({
      STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
      STUDIO_SARVAM_MODEL: "saaras:v4",
      STUDIO_INTELLIGENCE_PROVIDER: "gemini",
      STUDIO_GEMINI_MODEL: "gemini-3.5-flash",
    });
    expect(resolved.STUDIO_SARVAM_API_KEY).toBe(sarvamKey);
    expect(resolved.STUDIO_GEMINI_API_KEY).toBe(geminiKey);
    expect(configured).toEqual(before);
    expect(
      resolveStudioConfiguredProviderEnv(configured, {
        ...sealingEnv,
        STUDIO_GEMINI_MODEL: "gemini-3.1-pro-preview",
      }).STUDIO_GEMINI_MODEL,
    ).toBe("gemini-3.1-pro-preview");
  });

  it.each(["", 42, "https://example.test/collect"])(
    "rejects an invalid saved Studio model instead of using the chat model: %s",
    (studioModel) => {
      const configured = rows();
      configured[1].config = JSON.stringify({ model: "gemini-3.5-flash-lite", studioModel });
      expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
        "STUDIO_GEMINI_MODEL_REQUIRED",
      );
    },
  );

  it("requires an explicit instance when multiple providers of the same kind are active", () => {
    const configured = rows();
    configured.push({ ...configured[0], provider: "dq-translation" });
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      "STUDIO_SARVAM_PROVIDER_AMBIGUOUS",
    );
    expect(
      resolveStudioConfiguredProviderEnv(configured, {
        ...sealingEnv,
        STUDIO_SARVAM_PROVIDER: "sarvam-chat",
        STUDIO_GEMINI_PROVIDER: "gemini-chat",
      }).STUDIO_SARVAM_API_KEY,
    ).toBe(sarvamKey);
  });

  it("never silently falls back from a chosen disabled or missing provider", () => {
    const configured = rows();
    configured[0].active = false;
    expect(() =>
      resolveStudioConfiguredProviderEnv(configured, {
        ...sealingEnv,
        STUDIO_SARVAM_PROVIDER: "sarvam-chat",
      }),
    ).toThrow("STUDIO_SARVAM_PROVIDER_DISABLED");
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      "STUDIO_SARVAM_PROVIDER_NOT_CONFIGURED",
    );
    expect(() =>
      resolveStudioConfiguredProviderEnv(rows(), {
        ...sealingEnv,
        STUDIO_GEMINI_PROVIDER: "sarvam-chat",
      }),
    ).toThrow("STUDIO_GEMINI_PROVIDER_NOT_FOUND");
  });

  it("supports explicit speech model configuration without treating a chat model as ASR", () => {
    const configured = rows();
    configured[0].config = JSON.stringify({ model: "sarvam-105b", asrModel: "saaras:v3" });
    expect(resolveStudioConfiguredProviderEnv(configured, sealingEnv).STUDIO_SARVAM_MODEL).toBe(
      "saaras:v3",
    );
    configured[0].config = JSON.stringify({ model: "saaras:v3" });
    expect(resolveStudioConfiguredProviderEnv(configured, sealingEnv).STUDIO_SARVAM_MODEL).toBe(
      "saaras:v3",
    );
    expect(
      resolveStudioConfiguredProviderEnv(configured, {
        ...sealingEnv,
        STUDIO_SARVAM_MODEL: "saaras:v4",
        STUDIO_GEMINI_MODEL: "gemini-3.1-pro-preview",
      }).STUDIO_GEMINI_MODEL,
    ).toBe("gemini-3.1-pro-preview");
    expect(() =>
      resolveStudioConfiguredProviderEnv(configured, {
        ...sealingEnv,
        STUDIO_SARVAM_MODEL: "sarvam-105b",
      }),
    ).toThrow("STUDIO_SARVAM_MODEL_UNSUPPORTED");
  });

  it.each([null, "{}", '{"model":""}', '{"model":"https://example.test/collect"}'])(
    "requires an explicit valid Gemini model for config %s",
    (config) => {
      const configured = rows();
      configured[1].config = config;
      expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
        "STUDIO_GEMINI_MODEL_REQUIRED",
      );
    },
  );

  it.each(["not json", "[]", "null", "42"])("rejects malformed configuration %s", (config) => {
    const configured = rows();
    configured[1].config = config;
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      "STUDIO_GEMINI_CONFIG_INVALID",
    );
  });

  it("fails safely when the master key is absent, wrong, or a ciphertext was moved", () => {
    for (const env of [{}, { APP_SECRETS_KEY: "wrong-test-sealing-key-at-least-32-chars" }]) {
      expect(() => resolveStudioConfiguredProviderEnv(rows(), env)).toThrow(
        /^STUDIO_SARVAM_SECRET_UNAVAILABLE$/,
      );
    }
    const configured = rows();
    configured[0].provider = "another-provider";
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      /^STUDIO_SARVAM_SECRET_UNAVAILABLE$/,
    );
  });

  it.each([null, "{}", '{"apiKey":" "}', '{"apiKey":4}'])(
    "refuses empty credentials %s without accepting an unrelated environment key",
    (secret) => {
      const configured = rows();
      configured[0].secrets = secret;
      expect(() =>
        resolveStudioConfiguredProviderEnv(configured, {
          ...sealingEnv,
          STUDIO_SARVAM_API_KEY: "must-not-be-used",
        }),
      ).toThrow("STUDIO_SARVAM_KEY_REQUIRED");
    },
  );

  it("rejects unsafe secret shapes without returning their content", () => {
    const configured = rows();
    configured[0].secrets = "secret-value-not-json";
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      /^STUDIO_SARVAM_SECRET_INVALID$/,
    );
    configured[0].secrets = JSON.stringify({ apiKey: "secret\r\nheader:value" });
    expect(() => resolveStudioConfiguredProviderEnv(configured, sealingEnv)).toThrow(
      /^STUDIO_SARVAM_SECRET_INVALID$/,
    );
  });

  it("returns an allowlisted readiness projection containing no credentials", () => {
    const resolved = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const readiness = studioConfiguredProviderReadiness({
      ...resolved,
      APP_SECRETS_KEY: sealingEnv.APP_SECRETS_KEY,
      UNEXPECTED_SECRET: "not-for-readiness",
    });
    expect(Object.keys(readiness)).toHaveLength(6);
    expect(readiness.STUDIO_GEMINI_CONFIGURED).toBe("true");
    expect(JSON.stringify(readiness)).not.toMatch(/API_KEY|SECRET|test-only|not-for-readiness/);
  });

  it("does not give the isolated worker the core database URL or encryption master key", () => {
    const resolved = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const childEnv = studioConfiguredWorkerEnv(
      {
        ...sealingEnv,
        DATABASE_URL: "postgres://core.example.test/app",
        STUDIO_CORE_DATABASE_URL: "postgres://alternate.example.test/app",
        DISTRIBUTION_DATABASE_URL: "postgres://localhost/hub",
        STUDIO_GEMINI_API_KEY: "stale-value",
        STUDIO_WORKER_ENABLED: "true",
      },
      resolved,
    );
    expect(childEnv.APP_SECRETS_KEY).toBeUndefined();
    expect(childEnv.DATABASE_URL).toBeUndefined();
    expect(childEnv.STUDIO_CORE_DATABASE_URL).toBeUndefined();
    expect(childEnv.STUDIO_GEMINI_API_KEY).toBe(geminiKey);
    expect(childEnv.DISTRIBUTION_DATABASE_URL).toBe("postgres://localhost/hub");
    expect(childEnv.STUDIO_WORKER_ENABLED).toBe("true");
  });

  it("preserves dedicated worker/runtime/S3 settings while dropping unrelated app credentials", () => {
    const resolved = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const required = {
      NODE_ENV: "production",
      PATH: "/test/bin",
      HOME: "/test/home",
      TMPDIR: "/test/tmp",
      LANG: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: "/test/ca.pem",
      PYTHONPATH: "/test/python",
      VIRTUAL_ENV: "/test/venv",
      STUDIO_WORKER_ENABLED: "true",
      STUDIO_WORKER_AUTHORIZATION_KEY: "test-authority-key",
      STUDIO_CHANNEL_CONFIG_FILE: "/test/private/channels.json",
      STUDIO_BRAND_LOGO_PATH: "/test/brand.png",
      STUDIO_SCRATCH_ROOT: "/test/scratch",
      DISTRIBUTION_DATABASE_URL: "postgres://localhost/hub",
      DISTRIBUTION_ASSET_BACKEND: "s3",
      DISTRIBUTION_FFMPEG_PATH: "/test/bin/ffmpeg",
      DISTRIBUTION_FFPROBE_PATH: "/test/bin/ffprobe",
      DISTRIBUTION_S3_BUCKET: "test-bucket",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "studio-assets",
      AWS_ACCESS_KEY_ID: "test-s3-id",
      AWS_SECRET_ACCESS_KEY: "test-s3-secret",
      AWS_SESSION_TOKEN: "test-s3-session",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/test/aws-token",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/test/role",
    };
    const unrelated = {
      ...sealingEnv,
      DATABASE_URL: "postgres://localhost/core",
      STUDIO_CORE_DATABASE_URL: "postgres://localhost/core-override",
      AUTH_SECRET: "test-auth-secret",
      NEXTAUTH_SECRET: "test-nextauth-secret",
      GOOGLE_CLIENT_SECRET: "test-oauth-secret",
      STRIPE_SECRET_KEY: "test-payment-secret",
      SARVAM_API_KEY: "test-generic-sarvam-key",
      GEMINI_API_KEY: "test-generic-gemini-key",
      PGHOST: "core.example.test",
      PGUSER: "test-core-user",
      PGPASSWORD: "test-core-password",
      PGPASSFILE: "/test/core-pgpass",
      NODE_OPTIONS: "--inspect=0",
      NODE_DEBUG: "http",
      DEBUG: "*",
      AWS_UNRELATED_APP_SECRET: "test-unrelated-aws-secret",
      NEXT_PUBLIC_UNUSED: "test-unrelated-public-value",
    };
    const parent = { ...required, ...unrelated };
    const worker = studioConfiguredWorkerEnv(parent, resolved);
    expect(worker).toEqual({ ...required, ...resolved });
    for (const key of Object.keys(unrelated)) expect(worker).not.toHaveProperty(key);
    expect(parent).toEqual({ ...required, ...unrelated });
  });
});

describe("Studio configured-provider revalidation", () => {
  afterEach(() => vi.useRealTimers());

  it("revalidates read-only configuration every 30 seconds without stopping unchanged work", async () => {
    vi.useFakeTimers();
    const initial = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const load = vi.fn().mockResolvedValue({ ...initial });
    const stop = vi.fn();
    const cancel = monitorStudioConfiguredProviders({ env: sealingEnv, initial, load, stop });
    await vi.advanceTimersByTimeAsync(29999);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledExactlyOnceWith(sealingEnv);
    await vi.advanceTimersByTimeAsync(30000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    cancel();
    await vi.advanceTimersByTimeAsync(60000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["STUDIO_SARVAM_API_KEY", "changed-test-only-key"],
    ["STUDIO_GEMINI_API_KEY", "changed-test-only-key"],
    ["STUDIO_SARVAM_MODEL", "saaras:v3"],
    ["STUDIO_GEMINI_MODEL", "gemini-3.1-pro-preview"],
    ["STUDIO_SARVAM_PROVIDER", "new-active-instance"],
  ])("stops exactly once when %s changes without disclosing values", async (key, value) => {
    vi.useFakeTimers();
    const initial = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const load = vi.fn().mockResolvedValue({ ...initial, [key]: value });
    const stop = vi.fn();
    monitorStudioConfiguredProviders({ env: sealingEnv, initial, load, stop });
    await vi.advanceTimersByTimeAsync(90000);
    expect(load).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledExactlyOnceWith("STUDIO_CONFIGURED_PROVIDER_CHANGED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when a provider is disabled", async () => {
    vi.useFakeTimers();
    const initial = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const disabled = rows();
    disabled[0].active = false;
    const load = vi.fn(async () => resolveStudioConfiguredProviderEnv(disabled, sealingEnv));
    const stop = vi.fn();
    monitorStudioConfiguredProviders({ env: sealingEnv, initial, load, stop });
    await vi.advanceTimersByTimeAsync(30000);
    expect(stop).toHaveBeenCalledExactlyOnceWith("STUDIO_CONFIGURED_PROVIDER_RECHECK_FAILED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed on database errors without passing a secret-bearing error to the supervisor", async () => {
    vi.useFakeTimers();
    const initial = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    const load = vi.fn().mockRejectedValue(new Error("password=secret apiKey=secret"));
    const stop = vi.fn();
    monitorStudioConfiguredProviders({ env: sealingEnv, initial, load, stop });
    await vi.advanceTimersByTimeAsync(30000);
    expect(stop).toHaveBeenCalledExactlyOnceWith("STUDIO_CONFIGURED_PROVIDER_RECHECK_FAILED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap checks and ignores results after shutdown", async () => {
    vi.useFakeTimers();
    const initial = resolveStudioConfiguredProviderEnv(rows(), sealingEnv);
    let complete: (value: Record<string, string>) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<Record<string, string>>((done) => {
          complete = done;
        }),
    );
    const stop = vi.fn();
    const cancel = monitorStudioConfiguredProviders({ env: sealingEnv, initial, load, stop });
    await vi.advanceTimersByTimeAsync(90000);
    expect(load).toHaveBeenCalledOnce();
    cancel();
    complete({ ...initial, STUDIO_GEMINI_MODEL: "gemini-new-model" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Studio configured-provider operator I/O safety", () => {
  it("reads only the configured kinds, in a read-only connection, and closes the pool", async () => {
    database.query.mockReset().mockResolvedValue({ rows: rows() });
    database.end.mockReset().mockResolvedValue(undefined);
    const env = {
      ...sealingEnv,
      DISTRIBUTION_HUB_STAGE: "TEST",
      STUDIO_CORE_DATABASE_URL: "postgres://localhost/app",
    };
    expect((await loadStudioConfiguredProviderEnv(env)).STUDIO_GEMINI_API_KEY).toBe(geminiKey);
    expect(database.options).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connectionString: env.STUDIO_CORE_DATABASE_URL,
        options: "-c default_transaction_read_only=on",
      }),
    );
    expect(database.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT provider, kind, active, config, secrets FROM provider_credentials WHERE kind = ANY($1::text[])",
      [["sarvam", "gemini", "openai"]],
    );
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("hides connection/query failure details and still closes the pool", async () => {
    database.query.mockReset().mockRejectedValue(new Error("database password=test-secret"));
    database.end.mockReset().mockResolvedValue(undefined);
    await expect(
      loadStudioConfiguredProviderEnv({ DATABASE_URL: "postgres://localhost/app" }),
    ).rejects.toThrow(/^STUDIO_CONFIGURED_PROVIDER_READ_FAILED$/);
    expect(database.end).toHaveBeenCalledOnce();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "permits the local core database in TEST at %s",
    (host) => {
      const value = `postgresql://${host}:5442/satsang`;
      expect(studioCoreDatabaseUrl({ DATABASE_URL: value, DISTRIBUTION_HUB_STAGE: "TEST" })).toBe(
        value,
      );
    },
  );

  it("refuses a nonlocal core database in TEST and hides malformed URLs", () => {
    expect(() =>
      studioCoreDatabaseUrl({
        DATABASE_URL: "postgres://user:password@remote.example.test/app",
        DISTRIBUTION_HUB_STAGE: "TEST",
      }),
    ).toThrow(/^STUDIO_LOCAL_TEST_CORE_DATABASE_REQUIRED$/);
    expect(() => studioCoreDatabaseUrl({ DATABASE_URL: "https://example.test" })).toThrow(
      /^STUDIO_CORE_DATABASE_INVALID$/,
    );
    expect(() => studioCoreDatabaseUrl({ DATABASE_URL: "badpassword" })).toThrow(
      /^STUDIO_CORE_DATABASE_INVALID$/,
    );
    expect(() => studioCoreDatabaseUrl({})).toThrow(/^STUDIO_CORE_DATABASE_REQUIRED$/);
  });

  it("redacts complete keys even across every possible output chunk boundary", () => {
    const message = `before ${sarvamKey}; ${geminiKey} after`;
    for (let split = 0; split <= message.length; split++) {
      let output = "";
      const redactor = studioSecretRedactor([sarvamKey, geminiKey], (safe) => {
        output += safe;
      });
      redactor.write(Buffer.from(message.slice(0, split)));
      redactor.write(Buffer.from(message.slice(split)));
      redactor.end();
      expect(output).toBe("before [REDACTED]; [REDACTED] after");
    }
  });

  it("preserves UTF-8 logs while redacting keys from single-byte output chunks", () => {
    let output = "";
    const redactor = studioSecretRedactor([sarvamKey], (safe) => {
      output += safe;
    });
    for (const byte of Buffer.from(`తెలుగు ${sarvamKey} ✓`)) redactor.write(Buffer.from([byte]));
    redactor.end();
    expect(output).toBe("తెలుగు [REDACTED] ✓");
  });
});

it("requires explicit fallback enablement and decrypts only its configured OpenAI connection", () => {
  const configured = [
    ...rows(),
    {
      provider: "hub-backup",
      kind: "openai",
      active: true,
      config: JSON.stringify({ model: "synthetic-model" }),
      secrets: sealForStorage(
        JSON.stringify({ apiKey: "synthetic-backup-key" }),
        "hub-backup",
        sealingEnv,
      ),
    },
  ];
  expect(resolveStudioConfiguredProviderEnv(configured, sealingEnv)).not.toHaveProperty(
    "STUDIO_OPENAI_API_KEY",
  );
  const enabled = resolveStudioConfiguredProviderEnv(configured, {
    ...sealingEnv,
    STUDIO_FALLBACK_ENABLED: "true",
    STUDIO_OPENAI_PROVIDER: "hub-backup",
  });
  expect(enabled.STUDIO_OPENAI_API_KEY).toBe("synthetic-backup-key");
  expect(JSON.stringify(studioConfiguredProviderReadiness(enabled))).not.toContain(
    "synthetic-backup-key",
  );
  expect(() =>
    resolveStudioConfiguredProviderEnv(rows(), { ...sealingEnv, STUDIO_FALLBACK_ENABLED: "true" }),
  ).toThrow("STUDIO_OPENAI_PROVIDER_NOT_CONFIGURED");
});
