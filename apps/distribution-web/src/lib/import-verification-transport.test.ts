import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { importVerificationRequest, verificationTransport } from "./import-verification";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("distinguishes missing configuration, disconnected service and failed browser startup", async () => {
  const context = { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
  const command = { action: "start" as const };
  vi.stubEnv("STUDIO_IMPORT_VERIFICATION_KEY", "");
  await expect(importVerificationRequest(context, "import", command)).rejects.toThrow(
    "VERIFICATION_NOT_CONFIGURED",
  );
  vi.stubEnv("STUDIO_IMPORT_VERIFICATION_KEY", "a".repeat(64));
  vi.stubEnv("STUDIO_IMPORT_VERIFICATION_ORIGIN", "http://127.0.0.1:3073");
  vi.stubEnv("STUDIO_IMPORT_VERIFICATION_CA", "");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Error("private connection detail")));
  await expect(importVerificationRequest(context, "import", command)).rejects.toThrow(
    "VERIFICATION_CONNECTION_FAILED",
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "VERIFICATION_BROWSER_START_FAILED" }, { status: 409 }),
      ),
  );
  await expect(importVerificationRequest(context, "import", command)).rejects.toThrow(
    "VERIFICATION_BROWSER_START_FAILED",
  );
});

it("pins the environment certificate, rejects other trust roots, and never follows redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-tls-test-"));
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const key = await readFile(keyFile);
  const cert = await readFile(certFile);
  const server = createServer({ key, cert }, (request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { Location: "https://example.test" });
    else response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NO_PORT");
  const origin = `https://127.0.0.1:${address.port}`;
  const options = () => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cache: "no-store" as const,
    redirect: "error" as const,
    signal: AbortSignal.timeout(2000),
  });
  try {
    expect((await verificationTransport(origin, cert.toString("base64"), options())).status).toBe(
      200,
    );
    await expect(
      verificationTransport(
        origin,
        Buffer.from("not this certificate").toString("base64"),
        options(),
      ),
    ).rejects.toThrow();
    await expect(
      verificationTransport(`${origin}/redirect`, cert.toString("base64"), options()),
    ).rejects.toThrow("VERIFICATION_UNAVAILABLE");
    await expect(
      verificationTransport(origin.replace("https:", "http:"), cert.toString("base64"), options()),
    ).rejects.toThrow("VERIFICATION_UNAVAILABLE");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
