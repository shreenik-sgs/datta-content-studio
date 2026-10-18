import { expect, it } from "vitest";
import { isOnlineBundle, onlineVideoBundle } from "./online-video";

it("accepts 60 ordered episode links and deduplicates canonical equivalents", () => {
  const links = Array.from(
    { length: 60 },
    (_, n) => `https://youtu.be/E${String(n).padStart(10, "0")}`,
  );
  const result = onlineVideoBundle([...links, `${links[0]}?si=share`, ""].join("\n"));
  expect(result).toHaveLength(60);
  expect(result[0]?.id).toBe("E0000000000");
  expect(result[59]?.id).toBe("E0000000059");
  expect(result.every((source) => source.kind === "video")).toBe(true);
  const first = result[0];
  if (!first) throw Error("missing first");
  expect(isOnlineBundle({ ...first, kind: "bundle" })).toBe(true);
});
it.each(["", Array(101).fill("https://youtu.be/E0000000000").join("\n")])(
  "bounds a series without silently dropping links",
  (links) => {
    expect(() => onlineVideoBundle(links)).toThrow("ONLINE_BUNDLE_SIZE_INVALID");
  },
);
it.each([
  "https://localhost/video",
  "https://youtube.com/playlist?list=PL1234567890",
  "https://user:password@youtube.com/watch?v=E0000000000",
])("rejects an invalid source before any import: %s", (link) => {
  expect(() => onlineVideoBundle(`https://youtu.be/E0000000000\n${link}`)).toThrow();
});
it("keeps verification and shared ownership scoped to one provider", () => {
  expect(() =>
    onlineVideoBundle(
      "https://youtu.be/E0000000000\nhttps://www.facebook.com/watch/?v=1234567890123",
    ),
  ).toThrow("ONLINE_BUNDLE_PROVIDER_MISMATCH");
});
