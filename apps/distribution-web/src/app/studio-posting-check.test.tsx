// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioPostingCheck } from "./studio-posting-check";
import { value } from "./studio-workflow-fixture";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("shows per-file history only on request, flags possible duplicates, and never posts", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const output = value.outputs[0];
  if (!output) throw Error("MISSING_OUTPUT");
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      checks: {
        [output.id]: {
          checkedAt: new Date().toISOString(),
          destination: "youtube:abc",
          scanned: 20,
          error: null,
          matches: [
            {
              state: "NEEDS_REVIEW",
              reason: "SIMILAR_METADATA",
              origin: "channel",
              url: "https://www.youtube.com/watch?v=abcdefghijk",
              postedAt: null,
            },
          ],
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <StudioPostingCheck
          packageId={value.id}
          revision={value.revision}
          accountId="guru"
          outputs={[output]}
          publications={[]}
        />,
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Not posted through Studio");
    await act(async () => host.querySelector("button")?.click());
    expect(fetcher.mock.calls[0]?.[0]).toContain("/posting-check");
    expect(host.textContent).toContain("Possible duplicate — review required");
    expect(host.querySelector("a")?.href).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(host.textContent).not.toContain("Already posted — will skip");
    expect(host.textContent).toContain("20 channel posts");
  } finally {
    await act(async () => root.unmount());
  }
});
