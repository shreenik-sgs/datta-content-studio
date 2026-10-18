import { createHmac, timingSafeEqual } from "node:crypto";
import { type RequestListener, createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { importVerificationEnvelopeSchema } from "@satsang/distribution-contracts";
import type { createImportVerificationManager } from "./import-verification-browser.js";

/** Private, authenticated control plane. Browsers only call the signed-in Hub proxy. */
export async function startImportVerificationServer(
  manager: ReturnType<typeof createImportVerificationManager>,
  env: NodeJS.ProcessEnv,
) {
  const key = env.STUDIO_IMPORT_VERIFICATION_KEY;
  const port = Number(env.STUDIO_IMPORT_VERIFICATION_PORT);
  if (!key || !/^[a-f0-9]{64}$/.test(key) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("VERIFICATION_UNAVAILABLE");
  const host = env.STUDIO_IMPORT_VERIFICATION_HOST ?? "127.0.0.1";
  const cert = env.STUDIO_IMPORT_VERIFICATION_TLS_CERT;
  const privateKey = env.STUDIO_IMPORT_VERIFICATION_TLS_KEY;
  if (
    Boolean(cert) !== Boolean(privateKey) ||
    (!["127.0.0.1", "localhost", "::1"].includes(host) && !cert)
  )
    throw Error("VERIFICATION_UNAVAILABLE");
  const seen = new Map<string, number>();
  const handler: RequestListener = async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const finish = (status: number, data: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(data));
    };
    try {
      if (request.method !== "POST" || request.url !== "/verification" || request.headers.origin) {
        finish(403, { error: "FORBIDDEN" });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 8192) throw Error("INVALID_REQUEST");
        chunks.push(part);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers["x-import-signature"];
      const expected = createHmac("sha256", key)
        .update("import-verification:v1\n")
        .update(raw)
        .digest();
      if (
        typeof signature !== "string" ||
        !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(expected, Buffer.from(signature, "hex"))
      ) {
        finish(403, { error: "FORBIDDEN" });
        return;
      }
      const data = importVerificationEnvelopeSchema.parse(JSON.parse(raw));
      const now = Date.now();
      for (const [id, time] of seen) if (now - time > 20000) seen.delete(id);
      if (
        Math.abs(now - data.requestedAt) > 10000 ||
        seen.has(data.requestId) ||
        seen.size >= 4000
      ) {
        finish(403, { error: "FORBIDDEN" });
        return;
      }
      seen.set(data.requestId, now);
      finish(
        200,
        await manager.handle(
          { userId: data.userId, isTest: data.isTest, roles: data.roles },
          data.importId,
          data.command,
        ),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      finish(code === "FORBIDDEN" ? 403 : 409, {
        error: [
          "VERIFICATION_EXPIRED",
          "VERIFICATION_BUSY",
          "VERIFICATION_NOT_NEEDED",
          "VERIFICATION_FAILED",
          "FORBIDDEN",
        ].includes(code)
          ? code
          : "VERIFICATION_UNAVAILABLE",
      });
    }
  };
  const server =
    cert && privateKey
      ? createTlsServer(
          {
            cert: Buffer.from(cert, "base64"),
            key: Buffer.from(privateKey, "base64"),
            minVersion: "TLSv1.2",
          },
          handler,
        )
      : createServer(handler);
  server.requestTimeout = 15000;
  server.maxHeadersCount = 20;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
