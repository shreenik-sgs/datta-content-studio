import { isAbsolute } from "node:path";
import {
  canonicalDestinationEvidenceSchema,
  destinationEvidenceSchema,
} from "@satsang/distribution-contracts";
import type {
  DestinationEvidence,
  createDistributionActivationRepository,
} from "@satsang/distribution-db";
import { type TrackedLinkRecord, validateCtaDestination } from "@satsang/distribution-domain";
export type { PersistedActivation } from "@satsang/distribution-db";
export type { TrackedLinkRecord } from "@satsang/distribution-domain";
type Repository = Pick<
  ReturnType<typeof createDistributionActivationRepository>,
  "refreshCandidates" | "refresh" | "deliverNext"
>;
type Check = (
  paths: readonly string[],
  signal: AbortSignal,
  version?: 1 | 2,
) => Promise<DestinationEvidence>;
type Publisher = { publish(record: TrackedLinkRecord): Promise<unknown> };
export function linkJobConfig(env: Record<string, string | undefined>) {
  if (env.DISTRIBUTION_LINK_JOBS_ENABLED !== "true") return null;
  if (env.DISTRIBUTION_HUB_ENABLED !== "true" || env.DISTRIBUTION_HUB_STAGE !== "TEST")
    throw new Error("LOCAL_TEST_WORKER_ONLY");
  const root = env.DISTRIBUTION_LINKS_CACHE_ROOT;
  const privateKeyFile = env.DISTRIBUTION_LINKS_PRIVATE_KEY_FILE;
  const keyId = env.DISTRIBUTION_LINKS_KEY_ID;
  const origin = env.STUDIO_DESTINATION_ORIGIN;
  const key = env.DISTRIBUTION_DESTINATION_KEY;
  if (
    !root ||
    !privateKeyFile ||
    !isAbsolute(root) ||
    !isAbsolute(privateKeyFile) ||
    !keyId ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) ||
    !origin ||
    !key
  )
    throw new Error("LOCAL_LINK_JOB_CONFIG_REQUIRED");
  return { root, privateKeyFile, keyId, origin, key };
}
export function createLocalDestinationChecker(options: {
  origin: string;
  key: string;
  fetcher?: typeof fetch;
}): Check {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new Error("LOCAL_CORE_REQUIRED");
  }
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.port !== "3020" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("LOCAL_CORE_REQUIRED");
  if (options.key.length < 32 || options.key.length > 200 || /\s/.test(options.key))
    throw new Error("DESTINATION_KEY_REQUIRED");
  const fetcher = options.fetcher ?? fetch;
  const key = options.key;
  return async (paths, signal, version = 1) => {
    if (paths.length < 1 || paths.length > 2 || new Set(paths).size !== paths.length)
      throw new Error("INVALID_DESTINATION_REQUEST");
    for (const path of paths) validateCtaDestination(path);
    const response = await fetcher(`${origin.origin}/api/v1/destination-status`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(version === 1 ? { paths } : { version, paths }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
    });
    if (!response.ok || !response.body) throw new Error("DESTINATION_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > 8192) {
          await reader.cancel();
          throw new Error("DESTINATION_UNAVAILABLE");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const evidence = (
      version === 1 ? destinationEvidenceSchema : canonicalDestinationEvidenceSchema
    ).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      evidence.results.length !== paths.length ||
      evidence.results.some((result) => !paths.includes(result.path)) ||
      Math.abs(Date.now() - Date.parse(evidence.checkedAt)) > 10000
    )
      throw new Error("DESTINATION_UNAVAILABLE");
    return evidence;
  };
}
export async function runLinkRefreshOnce(options: {
  repository: Repository;
  checkDestinations: Check;
  signal: AbortSignal;
}): Promise<{ refreshed: number; unavailable: number }> {
  if (options.signal.aborted) return { refreshed: 0, unavailable: 0 };
  const candidates = await options.repository.refreshCandidates({ isTest: true, limit: 20 });
  let next = 0;
  let refreshed = 0;
  let unavailable = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (!options.signal.aborted) {
        const activation = candidates[next++];
        if (!activation) return;
        try {
          const destinations = await options.checkDestinations(
            [activation.pinnedCta.destination.path, activation.pinnedCta.fallback.path],
            options.signal,
            activation.reviewPackage ? 2 : 1,
          );
          if (options.signal.aborted) return;
          await options.repository.refresh({ isTest: true, id: activation.id, destinations });
          refreshed++;
        } catch {
          unavailable++;
        }
      }
    }),
  );
  return { refreshed, unavailable };
}
export async function runLinkDeliveryOnce(options: {
  repository: Repository;
  publisher: Publisher;
  signal: AbortSignal;
}): Promise<number> {
  let count = 0;
  while (!options.signal.aborted && count < 25) {
    const record = await options.repository.deliverNext({
      isTest: true,
      publish: (record) => options.publisher.publish(record),
    });
    if (!record) break;
    count++;
  }
  return count;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export async function runLinkJobs(options: {
  repository: Repository;
  publisher: Publisher;
  checkDestinations: Check;
  signal: AbortSignal;
  onUnavailable?: (part: "delivery" | "availability") => void;
}): Promise<void> {
  async function loop(part: "delivery" | "availability", interval: number) {
    let warned = false;
    while (!options.signal.aborted) {
      try {
        if (part === "delivery") await runLinkDeliveryOnce(options);
        else {
          const result = await runLinkRefreshOnce(options);
          if (result.unavailable > 0) throw new Error("DESTINATION_UNAVAILABLE");
        }
        warned = false;
      } catch {
        if (!warned) options.onUnavailable?.(part);
        warned = true;
      }
      await wait(interval, options.signal);
    }
  }
  await Promise.all([loop("delivery", 1000), loop("availability", 10000)]);
}
