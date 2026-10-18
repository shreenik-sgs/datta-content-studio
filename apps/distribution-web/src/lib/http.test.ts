import { describe, expect, it } from "vitest";
import { acquireMasterUpload, readBoundedBody, readBoundedFormData, safeProblem } from "./http";

describe("DS-DIST-R1 HTTP boundary", () => {
  it("DS-DIST-R1-ASSET bounds chunked bodies before multipart parsing", async () => {
    const request = new Request("http://localhost", { method: "POST", body: "12345" });
    await expect(readBoundedBody(request, 4)).rejects.toThrow("UPLOAD_TOO_LARGE");
    await expect(
      readBoundedBody(new Request("http://localhost", { method: "POST", body: "1234" }), 4),
    ).resolves.toEqual(new TextEncoder().encode("1234"));
  });
  it("DS-DIST-R1-ERROR never exposes SQL or secret details", async () => {
    const response = safeProblem(new Error("postgres://secret:password@host"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});

describe("master upload memory boundaries", () => {
  it("parses multipart at its exact limit and refuses chunked overflow", async () => {
    const form = new FormData();
    form.set("title", "Boundary test");
    form.set("file", new Blob(["synthetic bytes"], { type: "video/mp4" }), "qa.mp4");
    const source = new Request("http://localhost", { method: "POST", body: form });
    const bytes = await source.arrayBuffer();
    const request = () =>
      new Request("http://localhost", {
        method: "POST",
        headers: source.headers,
        body: bytes,
      });
    const result = await readBoundedFormData(request(), bytes.byteLength);
    expect(result.get("title")).toBe("Boundary test");
    expect(await (result.get("file") as File).text()).toBe("synthetic bytes");
    await expect(readBoundedFormData(request(), bytes.byteLength - 1)).rejects.toThrow(
      "UPLOAD_TOO_LARGE",
    );
    const announced = request();
    announced.headers.set("content-length", String(bytes.byteLength));
    await expect(readBoundedFormData(announced, bytes.byteLength - 1)).rejects.toThrow(
      "UPLOAD_TOO_LARGE",
    );
    expect(announced.bodyUsed).toBe(false);
  });
  it("returns a safe error for malformed multipart and releases capacity idempotently", async () => {
    await expect(
      readBoundedFormData(
        new Request("http://localhost", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=qa" },
          body: "invalid",
        }),
        100,
      ),
    ).rejects.toThrow("INVALID_REQUEST");
    const release = acquireMasterUpload();
    expect(() => acquireMasterUpload()).toThrow("UPLOAD_BUSY");
    expect(safeProblem(new Error("UPLOAD_BUSY")).status).toBe(429);
    release();
    const next = acquireMasterUpload();
    release();
    expect(() => acquireMasterUpload()).toThrow("UPLOAD_BUSY");
    next();
  });
});
