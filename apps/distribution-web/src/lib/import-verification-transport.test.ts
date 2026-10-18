import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verificationTransport } from "./import-verification";

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
