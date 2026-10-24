import { createHmac, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { ImportVerificationAction } from "@satsang/distribution-contracts";
import type { DistributionContext } from "@satsang/distribution-db";
function importVerificationConfig(env = process.env) {
  const key = env.STUDIO_IMPORT_VERIFICATION_KEY;
  try {
    const url = new URL(env.STUDIO_IMPORT_VERIFICATION_ORIGIN ?? "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !key ||
      !/^[a-f0-9]{64}$/.test(key) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      return null;
    return { origin: url.origin, key, ca: env.STUDIO_IMPORT_VERIFICATION_CA };
  } catch {
    return null;
  }
}
export async function importVerificationRequest(
  context: DistributionContext,
  importId: string,
  command: ImportVerificationAction,
) {
  const config = importVerificationConfig();
  if (!config) throw Error("VERIFICATION_NOT_CONFIGURED");
  const body = JSON.stringify({
    version: 1,
    userId: context.userId,
    isTest: context.isTest,
    roles: context.roles ?? [],
    importId,
    command,
    requestId: randomUUID(),
    requestedAt: Date.now(),
  });
  const signature = createHmac("sha256", config.key)
    .update("import-verification:v1\n")
    .update(body)
    .digest("hex");
  try {
    const response = await verificationTransport(`${config.origin}/verification`, config.ca, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Import-Signature": signature },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(command.action === "start" ? 60000 : 15000),
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(
        [
          "VERIFICATION_EXPIRED",
          "VERIFICATION_BUSY",
          "VERIFICATION_NOT_NEEDED",
          "VERIFICATION_FAILED",
          "VERIFICATION_BROWSER_START_FAILED",
          "FORBIDDEN",
        ].includes(data.error)
          ? data.error
          : "VERIFICATION_UNAVAILABLE",
      );
    return data;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("VERIFICATION_") || error.message === "FORBIDDEN")
    )
      throw error;
    throw Error("VERIFICATION_CONNECTION_FAILED");
  }
}

/** Trust only this environment's private certificate; never disable hostname or chain checks. */
export async function verificationTransport(
  url: string,
  ca: string | undefined,
  options: {
    method: string;
    headers: Record<string, string>;
    body: string;
    cache: "no-store";
    redirect: "error";
    signal: AbortSignal;
  },
): Promise<Response> {
  if (!ca) return fetch(url, options);
  if (new URL(url).protocol !== "https:") throw Error("VERIFICATION_UNAVAILABLE");
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        ca: Buffer.from(ca, "base64"),
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) response.destroy(Error("VERIFICATION_UNAVAILABLE"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 503;
          if (status >= 300 && status < 400) {
            reject(Error("VERIFICATION_UNAVAILABLE"));
            return;
          }
          resolve(new Response(Buffer.concat(chunks), { status }));
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}
