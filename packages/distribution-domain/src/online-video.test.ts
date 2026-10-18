import { describe, expect, it } from "vitest";
import { onlineVideoSource } from "./online-video";
describe("online master source normalization", () => {
  it("deduplicates YouTube watch, short, mobile and short-link variants", () => {
    const urls = [
      "https://youtu.be/g0zlErdfXlg?t=2",
      "https://www.youtube.com/watch?v=g0zlErdfXlg&list=PLQRSgdwcDtX6XPv4eZyRlOrmJOxTJ6jgN",
      "https://m.youtube.com/shorts/g0zlErdfXlg",
    ];
    for (const url of urls)
      expect(onlineVideoSource(url)).toEqual({
        provider: "youtube",
        kind: "video",
        id: "g0zlErdfXlg",
        url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
      });
  });
  it("imports only the video unless the curator deliberately selects the playlist", () => {
    const url =
      "https://www.youtube.com/watch?v=g0zlErdfXlg&list=PLQRSgdwcDtX6XPv4eZyRlOrmJOxTJ6jgN";
    expect(onlineVideoSource(url, true)).toMatchObject({
      kind: "playlist",
      id: "PLQRSgdwcDtX6XPv4eZyRlOrmJOxTJ6jgN",
    });
    expect(onlineVideoSource(url).kind).toBe("video");
  });
  it("normalizes Facebook videos and accepts public share redirects", () => {
    for (const url of [
      "https://www.facebook.com/sgsswamiji/videos/1234567890/",
      "https://m.facebook.com/watch/?v=1234567890",
      "https://facebook.com/reel/1234567890/",
    ])
      expect(onlineVideoSource(url).url).toBe("https://www.facebook.com/watch/?v=1234567890");
    expect(onlineVideoSource("https://fb.watch/ABC123/").provider).toBe("facebook");
    expect(onlineVideoSource("https://facebook.com/share/v/ABcd123/?mibextid=abc").url).toBe(
      "https://www.facebook.com/share/v/ABcd123/",
    );
  });
  it.each([
    "http://youtube.com/watch?v=g0zlErdfXlg",
    "https://youtube.com.evil.test/watch?v=g0zlErdfXlg",
    "https://youtube.com@127.0.0.1/watch?v=g0zlErdfXlg",
    "https://169.254.169.254/",
    "file:///etc/passwd",
    "https://youtube.com:444/watch?v=g0zlErdfXlg",
    "https://youtube.com/redirect?q=https://evil.test",
    "https://facebook.com/profile",
    "https://facebook.com/watch/?v=../etc",
  ])("rejects unsupported source %s", (url) =>
    expect(() => onlineVideoSource(url)).toThrow("UNSUPPORTED_VIDEO_LINK"),
  );
});
