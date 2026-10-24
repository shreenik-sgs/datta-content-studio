import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { createComputerRecoveryManager } from "./computer-recovery-manager";
import type { createImportVerificationManager } from "./import-verification-browser";
import { startImportVerificationServer } from "./import-verification-server";
it("authenticates the private control plane, refuses replays and never trusts an unsigned actor", async () => {
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address();
  if (!address || typeof address === "string") throw Error("NO_PORT");
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const handle = vi.fn(async () => ({ sessionId: randomUUID(), status: "OPEN" }));
  const key = "a".repeat(64);
  const server = await startImportVerificationServer(
    { handle } as unknown as ReturnType<typeof createImportVerificationManager>,
    { STUDIO_IMPORT_VERIFICATION_KEY: key, STUDIO_IMPORT_VERIFICATION_PORT: String(address.port) },
  );
  try {
    const url = `http://127.0.0.1:${address.port}/verification`;
    const data = {
      version: 1,
      userId: "curator",
      roles: ["CONTENT_COORDINATOR"],
      isTest: true,
      importId: randomUUID(),
      requestedAt: Date.now(),
      requestId: randomUUID(),
      command: { action: "start" },
    };
    const raw = JSON.stringify(data);
    const signature = createHmac("sha256", key)
      .update("import-verification:v1\n")
      .update(raw)
      .digest("hex");
    expect((await fetch(url, { method: "POST", body: raw })).status).toBe(403);
    const headers = { "Content-Type": "application/json", "X-Import-Signature": signature };
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
          body: raw,
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(url, { method: "POST", headers, body: raw.replace('"curator"', '"admin"') }))
        .status,
    ).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    expect((await fetch(url, { method: "POST", headers, body: raw })).status).toBe(200);
    expect(handle).toHaveBeenCalledWith(
      { userId: "curator", roles: ["CONTENT_COORDINATOR"], isTest: true },
      data.importId,
      { action: "start" },
    );
    expect((await fetch(url, { method: "POST", headers, body: raw })).status).toBe(403);
    expect(handle).toHaveBeenCalledOnce();
  } finally {
    await server.close();
  }
});

it("refuses a remotely reachable listener without TLS", async () => {
  await expect(
    startImportVerificationServer({} as ReturnType<typeof createImportVerificationManager>, {
      STUDIO_IMPORT_VERIFICATION_KEY: "a".repeat(64),
      STUDIO_IMPORT_VERIFICATION_PORT: "3073",
      STUDIO_IMPORT_VERIFICATION_HOST: "0.0.0.0",
    }),
  ).rejects.toThrow("VERIFICATION_UNAVAILABLE");
});

it("separately authenticates recovery commands and refuses cross-endpoint signature reuse", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw Error("NO_PORT");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const handle = vi.fn(async () => ({ status: "IDLE", recordings: 0, completed: 0 }));
  const verification = vi.fn();
  const key = "b".repeat(64);
  const server = await startImportVerificationServer(
    { handle: verification } as unknown as ReturnType<typeof createImportVerificationManager>,
    { STUDIO_IMPORT_VERIFICATION_KEY: key, STUDIO_IMPORT_VERIFICATION_PORT: String(address.port) },
    { handle } as unknown as ReturnType<typeof createComputerRecoveryManager>,
  );
  try {
    const raw = JSON.stringify({
      version: 1,
      userId: "curator",
      roles: ["CONTENT_COORDINATOR"],
      isTest: true,
      importId: randomUUID(),
      requestedAt: Date.now(),
      requestId: randomUUID(),
      command: { action: "start", username: "Curator", password: "secret" },
    });
    const signature = (prefix: string) =>
      createHmac("sha256", key).update(prefix).update(raw).digest("hex");
    const post = (path: string, prefix: string) =>
      fetch(`http://127.0.0.1:${address.port}/${path}`, {
        method: "POST",
        headers: { "X-Import-Signature": signature(prefix) },
        body: raw,
      });
    expect((await post("computer-recovery", "import-verification:v1\n")).status).toBe(403);
    expect((await post("computer-recovery", "computer-recovery:v1\n")).status).toBe(200);
    expect((await post("computer-recovery", "computer-recovery:v1\n")).status).toBe(403);
    expect(handle).toHaveBeenCalledOnce();
    expect(verification).not.toHaveBeenCalled();
  } finally {
    await server.close();
  }
});
