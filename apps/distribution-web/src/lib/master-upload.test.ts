import { afterEach, expect, it, vi } from "vitest";
import { uploadMaster } from "./master-upload";
afterEach(() => vi.unstubAllGlobals());
it("rejects an oversized master before transferring bytes", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const file = new Blob(["video"]);
  Object.defineProperty(file, "size", { value: 262144001 });
  const form = { get: () => file } as unknown as FormData;
  await expect(uploadMaster("/upload", form)).rejects.toThrow("250 MB");
  expect(request).not.toHaveBeenCalled();
});
it("recognizes an HTML proxy 413 response", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Too large", { status: 413 })));
  await expect(uploadMaster("/upload", new FormData())).rejects.toThrow("250 MB");
});
it("preserves a specific server refusal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ error: "INVALID_MEDIA" }, { status: 400 })),
  );
  await expect(uploadMaster("/upload", new FormData())).rejects.toThrow("INVALID_MEDIA");
});
it("returns the uploaded content response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ content: { id: "master" } }, { status: 201 })),
  );
  expect(await (await uploadMaster("/upload", new FormData())).json()).toEqual({
    content: { id: "master" },
  });
});

it("accepts the 131 MB master without a client size refusal", async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ content: { id: "master" } }));
  vi.stubGlobal("fetch", request);
  const file = new Blob(["video"]);
  Object.defineProperty(file, "size", { value: 131396426 });
  await uploadMaster("/upload", { get: () => file } as unknown as FormData);
  expect(request).toHaveBeenCalledOnce();
});
it("refuses files above the administrator's lower limit before network transfer", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const file = new Blob(["video"]);
  Object.defineProperty(file, "size", { value: 131396426 });
  await expect(
    uploadMaster("/upload", { get: () => file } as unknown as FormData, 100 * 1024 * 1024),
  ).rejects.toThrow("100 MB");
  expect(request).not.toHaveBeenCalled();
});
it("explains duplicates instead of showing a generic upload failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ error: "DUPLICATE_MASTER" }, { status: 409 })),
  );
  await expect(uploadMaster("/upload", new FormData())).rejects.toThrow(
    "already in the Master Library",
  );
});
