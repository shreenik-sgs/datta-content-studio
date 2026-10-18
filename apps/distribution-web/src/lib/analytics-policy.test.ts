import { afterEach, expect, it, vi } from "vitest";
import { analyticsEnabled } from "./analytics-policy";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("uses its own opt-in without contacting Sannidhi or forwarding cookies", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  const request = new Request("http://localhost", { headers: { cookie: "ds_session=private" } });
  vi.stubEnv("STUDIO_ANALYTICS_ENABLED", "");
  expect(await analyticsEnabled(request)).toBe(false);
  vi.stubEnv("STUDIO_ANALYTICS_ENABLED", "true");
  expect(await analyticsEnabled(request)).toBe(true);
  expect(network).not.toHaveBeenCalled();
});
