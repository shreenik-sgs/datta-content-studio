import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), discover: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access }));
vi.mock("./buffer-channels", () => ({ findBufferYoutubeChannels: m.discover }));
import { POST } from "../app/api/settings/buffer-channels/route";
const request = (body: unknown) =>
  new Request("http://localhost/distribution/api/settings/buffer-channels", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({ ok: true });
});
it("requires admin settings authority before reading any provider account", async () => {
  m.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await POST(request({ accessToken: "synthetic" }))).status).toBe(403);
  expect(m.access).toHaveBeenCalledWith(expect.any(Request), "operations.manage");
  expect(m.discover).not.toHaveBeenCalled();
});
it("does not call the provider with invalid input and redacts external errors", async () => {
  expect((await POST(request({ accessToken: "bad\nheader" }))).status).toBe(400);
  expect(m.discover).not.toHaveBeenCalled();
  m.discover.mockRejectedValue(new Error("synthetic-sensitive-provider-response"));
  const response = await POST(request({ accessToken: "synthetic-key" }));
  expect(await response.text()).not.toContain("synthetic");
});
