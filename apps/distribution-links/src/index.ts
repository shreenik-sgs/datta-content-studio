import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createSignedLinkCacheReader } from "./cache.js";
import { createSocialEventOutbox } from "./event-outbox.js";
import { createLinkHandler, createLinkServer, linksRuntimeConfig } from "./service.js";
async function main() {
  const config = linksRuntimeConfig(process.env);
  if (!config) {
    console.info("Distribution links are OFF; no listener or cache was opened.");
    return;
  }
  const file = await open(config.publicKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let publicKey: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192) throw new Error("INVALID_PUBLIC_KEY");
    publicKey = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const cache = createSignedLinkCacheReader({
    root: config.root,
    publicKeys: { [config.keyId]: publicKey },
  });
  const events =
    config.socialLinksEnabled && config.eventRoot && config.coreOrigin && config.destinationKey
      ? createSocialEventOutbox({
          root: config.eventRoot,
          coreOrigin: config.coreOrigin,
          key: config.destinationKey,
        })
      : undefined;
  const server = createLinkServer(
    createLinkHandler({
      enabled: true,
      stage: "TEST",
      cache,
      socialLinksEnabled: config.socialLinksEnabled,
      ...(events ? { events } : {}),
      onAttributionUnavailable: (reason) => console.error(`Anonymous link attribution ${reason}.`),
    }),
  );
  let draining = false;
  let collectorUnavailable = false;
  const eventTimer = events
    ? setInterval(() => {
        if (draining) return;
        draining = true;
        void events
          .drainOnce()
          .then((result) => {
            const unavailable = result.pending > 0 && result.delivered === 0;
            if (unavailable && !collectorUnavailable)
              console.error(
                "Anonymous link attribution collector unavailable; queued receipts retained.",
              );
            collectorUnavailable = unavailable;
          })
          .catch(() => console.error("Anonymous link attribution delivery pending."))
          .finally(() => {
            draining = false;
          });
      }, 2000)
    : undefined;
  const stop = () => {
    clearInterval(eventTimer);
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.on("error", () => {
    console.error("Distribution links listener unavailable.");
    process.exitCode = 1;
  });
  server.listen(3071, "127.0.0.1", () =>
    console.info("Distribution links TEST listening on http://127.0.0.1:3071."),
  );
}
main().catch(() => {
  console.error(
    "Distribution links could not start; verify local TEST cache and public key configuration.",
  );
  process.exitCode = 1;
});
