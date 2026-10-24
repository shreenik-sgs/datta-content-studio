import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ImportVerificationAction,
  ImportVerificationState,
} from "@satsang/distribution-contracts";
import type { DistributionContext } from "@satsang/distribution-db";
import { type OnlineVideoSource, verificationSignInBlocked } from "@satsang/distribution-domain";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { type OnlineImportWorkerInput, runOnlineImportOnce } from "./online-import-worker.js";
import { downloadOnlineVideo } from "./online-video-download.js";
import { allowedVerificationHost, startOnlineVideoProxy } from "./online-video-network.js";

export function youtubeCookieJar(cookies: Awaited<ReturnType<BrowserContext["cookies"]>>) {
  const rows = cookies
    .filter((cookie) => cookie.domain === "youtube.com" || cookie.domain.endsWith(".youtube.com"))
    .map((cookie) => {
      if (
        [cookie.domain, cookie.path, cookie.name, cookie.value].some((value) =>
          [...value].some((char) => char.charCodeAt(0) < 32),
        )
      )
        throw Error("VERIFICATION_FAILED");
      return [
        cookie.domain,
        cookie.domain.startsWith(".") ? "TRUE" : "FALSE",
        cookie.path,
        cookie.secure ? "TRUE" : "FALSE",
        Math.max(0, Math.floor(cookie.expires)),
        cookie.name,
        cookie.value,
      ].join("\t");
    });
  return `# Netscape HTTP Cookie File\n${rows.join("\n")}\n`;
}
export type VerificationBrowser = {
  snapshot: () => Promise<{
    image?: string;
    origin: string;
    error?: "VERIFICATION_SIGN_IN_BLOCKED";
  }>;
  command: (command: ImportVerificationAction) => Promise<void>;
  credentials: () => Promise<{ cookies: string; userAgent: string }>;
  close: () => Promise<void>;
};
export async function openVerificationBrowser(
  source: OnlineVideoSource,
): Promise<VerificationBrowser> {
  if (source.provider !== "youtube") throw Error("VERIFICATION_UNAVAILABLE");
  const proxy = await startOnlineVideoProxy(true);
  const home = await mkdtemp(join(tmpdir(), "sgs-verification-"));
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: false,
      env: {
        HOME: home,
        ...Object.fromEntries(
          ["PATH", "TMPDIR", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL"].flatMap((key) =>
            process.env[key] ? [[key, process.env[key] as string]] : [],
          ),
        ),
      },
      chromiumSandbox: true,
      proxy: { server: proxy.url },
      args: [
        "--disable-quic",
        "--disable-background-networking",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    // The network proxy independently resolves and pins public IPs. No arbitrary navigation,
    // browser downloads, extensions, clipboard, local files or access to AWS metadata.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443") ||
        !allowedVerificationHost(url.hostname)
      )
        await route.abort();
      else await route.continue();
    });
    const page = await context.newPage();
    context.on("page", (popup: Page) => {
      if (popup !== page) void popup.close();
    });
    await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return {
      snapshot: async () => {
        const origin = new URL(page.url()).origin;
        // Inspect only the rendered error, never form values, URLs with OAuth tokens or cookies.
        if (
          origin === "https://accounts.google.com" &&
          verificationSignInBlocked(origin, await page.locator("body").innerText({ timeout: 5000 }))
        )
          return { origin, error: "VERIFICATION_SIGN_IN_BLOCKED" };
        return {
          image: `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 })).toString("base64")}`,
          origin,
        };
      },
      command: async (command) => {
        switch (command.action) {
          case "click":
            await page.mouse.click(command.x, command.y);
            break;
          case "key":
            await page.keyboard.press(command.key);
            break;
          case "text":
            await page.keyboard.insertText(command.text);
            break;
          case "scroll":
            await page.mouse.wheel(0, command.delta);
            break;
        }
      },
      credentials: async () => ({
        cookies: youtubeCookieJar(await context.cookies()),
        userAgent: await page.evaluate(() => navigator.userAgent),
      }),
      close: async () => {
        await browser?.close().catch(() => undefined);
        await proxy.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await proxy.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
type Session = {
  id: string;
  context: DistributionContext;
  importId: string;
  status: ImportVerificationState["status"];
  expires: number;
  browser?: VerificationBrowser | undefined;
  credentials?: { cookies: string; userAgent: string } | undefined;
  sources: Set<string>;
  error?: string | undefined;
  controller: AbortController;
  checking?: Promise<void> | undefined;
};
/** This manager and its downloads run in ONE worker, so verification and downloads share egress.
 * Credentials live only in memory (yt-dlp receives a mode-0600 temporary jar), never in responses. */
export function createImportVerificationManager(
  input: OnlineImportWorkerInput,
  dependencies: {
    open?: typeof openVerificationBrowser;
    download?: typeof downloadOnlineVideo;
    clock?: () => number;
  } = {},
) {
  const clock = dependencies.clock ?? Date.now;
  const download = dependencies.download ?? downloadOnlineVideo;
  const sessions = new Map<string, Session>();
  let starting = false;
  const publicState = async (value: Session): Promise<ImportVerificationState> => {
    let snapshot = value.browser && value.status === "OPEN" ? await value.browser.snapshot() : {};
    if ("error" in snapshot && snapshot.error === "VERIFICATION_SIGN_IN_BLOCKED") {
      value.status = "FAILED";
      value.error = snapshot.error;
      value.credentials = undefined;
      const browser = value.browser;
      value.browser = undefined;
      await browser?.close().catch(() => undefined);
      snapshot = {};
    }
    return {
      sessionId: value.id,
      status: value.status,
      expiresAt: new Date(value.expires).toISOString(),
      ...snapshot,
      ...(value.error ? { error: value.error } : {}),
    };
  };
  async function dispose(value: Session) {
    value.controller.abort();
    await value.browser?.close();
    value.browser = undefined;
    value.credentials = undefined;
    value.status = "CLOSED";
    await value.checking?.catch(() => undefined);
  }
  async function check(value: Session) {
    try {
      value.credentials = await value.browser?.credentials();
      await value.browser?.close();
      value.browser = undefined;
      if (!value.credentials) throw Error("VERIFICATION_FAILED");
      // Reading a playlist alone is NOT proof of media access. Also download its first pending video.
      for (let pass = 0; pass < 2; pass++) {
        const claim = await input.repository.claimVerification(value.context, value.importId);
        let failed = false;
        await runOnlineImportOnce(
          {
            ...input,
            signal: AbortSignal.any([input.signal, value.controller.signal]),
            onError: () => {
              failed = true;
            },
          },
          (request) => download({ ...request, browserSession: value.credentials }),
          claim,
        );
        if (failed) throw Error("VERIFICATION_FAILED");
        const state = await input.repository.recoveryTarget(value.context, claim.id);
        if (claim.source.kind === "video") {
          if (!state.root.masterId) throw Error("VERIFICATION_FAILED");
          const imports = await input.repository.list(value.context, { rootId: value.importId });
          const root = imports.find((item) => item.id === value.importId);
          value.sources = new Set(
            imports
              .filter((item) => item.id === value.importId || root?.childIds?.includes(item.id))
              .map((item) => item.source.url),
          );
          if (root?.source.kind === "playlist" || root?.source.kind === "bundle")
            await input.repository.retryPlaylist(value.context, value.importId);
          value.status = "VERIFIED";
          value.expires = clock() + 2 * 60 * 60 * 1000;
          return;
        }
      }
      throw Error("VERIFICATION_FAILED");
    } catch (error) {
      if (!value.controller.signal.aborted) {
        value.status = "FAILED";
        value.error =
          error instanceof Error && error.message === "VERIFICATION_BUSY"
            ? "VERIFICATION_BUSY"
            : "VERIFICATION_FAILED";
      }
      value.credentials = undefined;
    }
  }
  const timer = setInterval(() => {
    for (const value of sessions.values())
      if (clock() >= value.expires) {
        sessions.delete(value.id);
        void dispose(value);
      }
  }, 15000);
  timer.unref();
  return {
    paused: () => [...sessions.values()].some((value) => value.status === "CHECKING"),
    download: async (request: Parameters<typeof downloadOnlineVideo>[0]) => {
      const value = [...sessions.values()].find(
        (value) =>
          value.status === "VERIFIED" &&
          clock() < value.expires &&
          value.sources.has(request.source.url),
      );
      const useSession = Boolean(value?.credentials);
      try {
        return await download({
          ...request,
          ...(useSession ? { browserSession: value?.credentials } : {}),
        });
      } catch (error) {
        if (
          useSession &&
          value &&
          error instanceof Error &&
          ["ONLINE_PROVIDER_VERIFICATION_REQUIRED", "ONLINE_SOURCE_RESTRICTED"].includes(
            error.message,
          )
        ) {
          value.status = "FAILED";
          value.credentials = undefined;
          value.error = "VERIFICATION_FAILED";
        }
        throw error;
      }
    },
    handle: async (
      context: DistributionContext,
      importId: string,
      command: ImportVerificationAction,
    ) => {
      if (context.isTest !== input.isTest) throw Error("FORBIDDEN");
      const { root, target } = await input.repository.recoveryTarget(context, importId);
      if (command.action === "start") {
        if (starting) throw Error("VERIFICATION_BUSY");
        if (root.source.provider !== "youtube") throw Error("VERIFICATION_UNAVAILABLE");
        if (!target || target.masterId) throw Error("VERIFICATION_NOT_NEEDED");
        const current = [...sessions.values()].find(
          (value) =>
            value.importId === importId &&
            value.context.userId === context.userId &&
            clock() < value.expires &&
            ["OPEN", "CHECKING", "VERIFIED"].includes(value.status),
        );
        if (current) return publicState(current);
        if (
          [...sessions.values()].some((value) => ["OPEN", "CHECKING"].includes(value.status)) ||
          sessions.size >= 10
        )
          throw Error("VERIFICATION_BUSY");
        starting = true;
        let session: Session | undefined;
        try {
          for (const prior of sessions.values())
            if (prior.importId === importId && prior.context.userId === context.userId) {
              await dispose(prior);
              sessions.delete(prior.id);
            }
          session = {
            id: randomUUID(),
            context,
            importId,
            status: "OPEN",
            expires: clock() + 15 * 60 * 1000,
            sources: new Set(),
            controller: new AbortController(),
          };
          sessions.set(session.id, session);
          session.browser = await (dependencies.open ?? openVerificationBrowser)(target.source);
          return publicState(session);
        } catch {
          if (session) {
            await dispose(session);
            sessions.delete(session.id);
          }
          input.onError?.("VERIFICATION_BROWSER_START_FAILED");
          throw Error("VERIFICATION_BROWSER_START_FAILED");
        } finally {
          starting = false;
        }
      }
      const value = sessions.get(command.sessionId);
      if (
        !value ||
        clock() >= value.expires ||
        command.sessionId !== value.id ||
        value.context.userId !== context.userId ||
        value.context.isTest !== context.isTest ||
        value.importId !== importId
      )
        throw Error("VERIFICATION_EXPIRED");
      if (command.action === "cancel") {
        await dispose(value);
        sessions.delete(value.id);
        return publicState(value);
      }
      if (command.action === "check") {
        // A direct check request must not download using a rejected sign-in either.
        if (value.status === "OPEN") await publicState(value);
        if (value.status === "OPEN") {
          value.status = "CHECKING";
          value.expires = clock() + 65 * 60 * 1000;
          value.checking = check(value);
        }
      } else if (command.action !== "status") {
        if (value.status !== "OPEN" || !value.browser) throw Error("VERIFICATION_EXPIRED");
        await value.browser.command(command);
      }
      return publicState(value);
    },
    close: async () => {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map(dispose));
      sessions.clear();
    },
  };
}
