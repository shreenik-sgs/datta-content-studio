import { createHash, randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import { isAbsolute } from "node:path";
import {
  type SocialLinkReceipt,
  type TrackedLinkRecord,
  normalizeDistributionStage,
  trackedLinkDecision,
} from "@satsang/distribution-domain";
import { linkCopy } from "./ui-copy.js";
type Cache = { read(token: string): Promise<TrackedLinkRecord | null> };
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const css = `:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#242124;background:#fbf5f8}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:clamp(20px,5vw,64px);background:linear-gradient(40deg,#f4dce7 0%,#fbf5f8 48%,#fff 100%)}main{width:min(100%,560px);padding:clamp(24px,6vw,48px);border:1px solid #eddee4;border-radius:28px;background:#fff;box-shadow:0 12px 40px #5a24430c;text-align:center}.brand{margin:0 0 40px;color:#922650;font-size:14px;font-weight:600;letter-spacing:.03em}h1{margin:0;color:#922650;font-size:clamp(22px,5vw,30px);line-height:1.3;font-weight:650;overflow-wrap:anywhere}p{line-height:1.6;overflow-wrap:anywhere}.note{font-size:15px;margin:20px 0 0;color:#52454b}a{display:block;margin-top:32px;min-height:48px;padding:14px 20px;border-radius:999px;background:#922650;color:#fff;font-weight:600;text-decoration:none;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #242124;outline-offset:4px}a:hover{background:#7b1e43}@media(max-width:360px){main{padding:24px 20px}.brand{margin-bottom:28px}}`;
const styleHash = createHash("sha256").update(css).digest("base64");
const headers = {
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
function page(
  input: {
    language: TrackedLinkRecord["language"];
    title: string;
    note?: string;
    token?: string;
    button?: string;
  },
  status = 200,
): Response {
  const body = `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)} · SGS Datta Sannidhi</title><style>${css}</style></head><body><main><p class="brand">SGS Datta Sannidhi</p><h1>${escapeHtml(input.title)}</h1>${input.note ? `<p class="note">${escapeHtml(input.note)}</p>` : ""}${input.token ? `<a href="/outreach/${input.token}/continue">${escapeHtml(input.button ?? linkCopy(input.language).continue)}</a>` : ""}</main></body></html>`;
  return new Response(body, {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
export function createLinkHandler(options: {
  enabled: boolean;
  stage: string | undefined;
  cache: Cache;
  now?: () => string;
  socialLinksEnabled?: boolean;
  events?: { enqueue(receipt: SocialLinkReceipt): Promise<void> };
  onAttributionUnavailable?: (reason: "spool_failed" | "spool_delayed") => void;
}) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    if (url.pathname === "/health")
      return Response.json(
        {
          service: "distribution-links",
          version: 1,
          stage: normalizeDistributionStage(options.stage),
          status: "ok",
        },
        { headers },
      );
    const socialMatch = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const match =
      socialMatch ?? /^\/outreach\/([A-Za-z0-9_-]{43})(\/continue)?$/.exec(url.pathname);
    if (
      !options.enabled ||
      options.stage !== "TEST" ||
      !match?.[1] ||
      url.search ||
      (socialMatch && options.socialLinksEnabled !== true)
    )
      return new Response(null, { status: 404, headers });
    const token = match[1];
    const record = await options.cache.read(token);
    if (!record) return page({ language: "en", title: linkCopy("en").unavailable }, 404);
    try {
      const at = options.now?.() ?? new Date().toISOString();
      const result = trackedLinkDecision(record, at);
      if (socialMatch) {
        if (!record.social) return new Response(null, { status: 404, headers });
        let attributionId: string | null = null;
        if (request.method === "GET" && options.events) {
          const receipt: SocialLinkReceipt = {
            version: 1,
            isTest: true,
            id: randomUUID(),
            occurredAt: at,
            name: result.usedFallback ? "tracked_link_fallback_used" : "tracked_link_resolved",
            activationId: record.activationId,
            campaignId: record.campaignId,
            contentId: record.contentId,
            derivativeId: record.derivativeId,
            ctaId: record.cta.id,
            channel: record.social.channel,
            canonicalId: result.usedFallback
              ? result.destination === "/explore"
                ? "library"
                : (/^\/content\/(room|event|seva)\/([0-9a-f-]{36})$/
                    .exec(result.destination)
                    ?.slice(1)
                    .join(":") ?? null)
              : record.social.canonicalId,
            fallbackReason: result.fallbackReason,
          };
          // Durable local enqueue is independent of collector delivery. Its failure or delay
          // cannot prevent a valid content redirect; no request identity enters this receipt.
          let finished = false;
          let persisted = false;
          const queued = options.events
            .enqueue(receipt)
            .then(() => {
              persisted = true;
            })
            .catch(() => {
              options.onAttributionUnavailable?.("spool_failed");
            })
            .finally(() => {
              finished = true;
            });
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            queued,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 25);
            }),
          ]);
          clearTimeout(timer);
          if (!finished) options.onAttributionUnavailable?.("spool_delayed");
          if (persisted) attributionId = receipt.id;
        }
        const accessMode = result.usedFallback
          ? record.social.fallbackAccessMode
          : record.social.accessMode;
        if (request.headers.get("accept")?.toLowerCase().includes("application/json")) {
          const response = Response.json(
            {
              version: 1,
              isTest: true,
              attributionId,
              destination: result.destination,
              requiresIdentity: result.requiresIdentity,
              accessMode,
              usedFallback: result.usedFallback,
              fallbackReason: result.fallbackReason,
              language: record.language,
            },
            { headers },
          );
          return request.method === "HEAD"
            ? new Response(null, { status: 200, headers: response.headers })
            : response;
        }
      }
      if (socialMatch || match[2])
        return new Response(null, {
          status: 302,
          headers: {
            ...headers,
            location: result.destination,
            "X-Distribution-World": "TEST",
            "X-Distribution-Requires-Identity": result.requiresIdentity ? "1" : "0",
            "X-Distribution-Language": record.language,
            ...(result.fallbackReason
              ? { "X-Distribution-Fallback-Reason": result.fallbackReason }
              : {}),
          },
        });
      const response = page({
        language: record.language,
        title: record.title,
        ...(result.usedFallback ? { note: linkCopy(record.language).alternative } : {}),
        token,
        button: result.usedFallback ? linkCopy(record.language).continue : record.cta.copy,
      });
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    } catch {
      return page({ language: "en", title: linkCopy("en").unavailable }, 404);
    }
  };
}
export function linksRuntimeConfig(env: Record<string, string | undefined>) {
  const stage = normalizeDistributionStage(env.DISTRIBUTION_LINKS_STAGE);
  if (env.DISTRIBUTION_LINKS_ENABLED !== "true" || stage === "OFF") return null;
  if (stage !== "TEST") throw new Error("LOCAL_TEST_RESOLVER_ONLY");
  const root = env.DISTRIBUTION_LINKS_CACHE_ROOT;
  const keyId = env.DISTRIBUTION_LINKS_KEY_ID;
  const publicKeyFile = env.DISTRIBUTION_LINKS_PUBLIC_KEY_FILE;
  if (
    !root ||
    !publicKeyFile ||
    !isAbsolute(root) ||
    !isAbsolute(publicKeyFile) ||
    !keyId ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)
  )
    throw new Error("LOCAL_RESOLVER_CONFIG_REQUIRED");
  const socialLinksEnabled = env.DISTRIBUTION_SOCIAL_LINKS_ENABLED === "true";
  const eventRoot = env.DISTRIBUTION_LINKS_EVENT_ROOT;
  const coreOrigin = env.STUDIO_DESTINATION_ORIGIN;
  const destinationKey = env.DISTRIBUTION_DESTINATION_KEY;
  if (
    socialLinksEnabled &&
    (!eventRoot || !isAbsolute(eventRoot) || !coreOrigin || !destinationKey)
  )
    throw new Error("SOCIAL_LINK_EVENT_CONFIG_REQUIRED");
  return {
    root,
    keyId,
    publicKeyFile,
    socialLinksEnabled,
    ...(socialLinksEnabled ? { eventRoot, coreOrigin, destinationKey } : {}),
  };
}
export function createLinkServer(handler: (request: Request) => Promise<Response>): Server {
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
    async (req, res) => {
      try {
        if ((req.url?.length ?? 0) > 512) {
          res.writeHead(414, headers);
          res.end();
          return;
        }
        const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method ?? "GET",
          headers: typeof req.headers.accept === "string" ? { Accept: req.headers.accept } : {},
        });
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (req.method === "HEAD") res.end();
        else res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(503, headers);
        res.end();
      }
    },
  );
  server.maxConnections = 64;
  server.keepAliveTimeout = 5000;
  return server;
}
