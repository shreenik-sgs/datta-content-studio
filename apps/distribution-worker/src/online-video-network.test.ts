import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import {
  allowedVideoHost,
  publicVideoAddress,
  startOnlineVideoProxy,
} from "./online-video-network";
describe("online import network isolation", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.31.8.9",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("refuses non-public DNS result %s", (ip) => expect(publicVideoAddress(ip)).toBe(false));
  it("accepts public provider addresses only", () => {
    expect(publicVideoAddress("142.250.192.14")).toBe(true);
    expect(publicVideoAddress("2607:f8b0:400a:801::200e")).toBe(true);
    expect(allowedVideoHost("rr1.sn.example.googlevideo.com")).toBe(true);
    expect(allowedVideoHost("scontent.example.fbcdn.net")).toBe(true);
    expect(allowedVideoHost("youtube.com.evil.test")).toBe(false);
    expect(allowedVideoHost("169.254.169.254")).toBe(false);
  });
  it("refuses HTTP and CONNECT requests to arbitrary hosts or ports", async () => {
    const proxy = await startOnlineVideoProxy();
    try {
      for (const request of [
        "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: metadata\r\n\r\n",
        "CONNECT youtube.com:80 HTTP/1.1\r\nHost: youtube.com\r\n\r\n",
        "GET http://127.0.0.1/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      ]) {
        const result = await new Promise<string>((resolve, reject) => {
          const socket = connect(Number(new URL(proxy.url).port), "127.0.0.1", () =>
            socket.write(request),
          );
          let text = "";
          socket.on("data", (d) => {
            text += d;
          });
          socket.on("end", () => resolve(text));
          socket.on("error", reject);
        });
        expect(result).toContain("403 Forbidden");
      }
    } finally {
      await proxy.close();
    }
  });
});
