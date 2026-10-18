import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { BlockList, type Socket, connect, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001:db8::", 32],
  ["2001::", 32],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function publicVideoAddress(address: string) {
  return isIP(address) === 4
    ? !blocked.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export function allowedVideoHost(host: string) {
  return [
    "youtube.com",
    "youtu.be",
    "googlevideo.com",
    "ytimg.com",
    "ggpht.com",
    "googleusercontent.com",
    "facebook.com",
    "fb.watch",
    "fbcdn.net",
  ].some((domain) => host === domain || host.endsWith(`.${domain}`));
}
/** Every redirect and fragment goes through this proxy. DNS is checked then pinned to its
 * public IP at connect time; the downloader still verifies the origin's TLS certificate. */
export function allowedVerificationHost(host: string) {
  return (
    allowedVideoHost(host) ||
    ["accounts.google.com", "www.google.com", "google.com", "consent.google.com"].includes(host) ||
    ["gstatic.com", "recaptcha.net"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  );
}
export async function startOnlineVideoProxy(verification = false) {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", async (request, client, head) => {
    try {
      const target = /^([a-zA-Z0-9.-]+):443$/.exec(request.url ?? "");
      const host = target?.[1]?.toLowerCase();
      if (
        !host ||
        !(verification ? allowedVerificationHost(host) : allowedVideoHost(host)) ||
        head.length
      )
        throw Error();
      const addresses = await lookup(host, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((a) => !publicVideoAddress(a.address))) throw Error();
      if (client.destroyed) return;
      const address = addresses[0];
      if (!address) throw Error();
      const upstream = connect({ host: address.address, family: address.family, port: 443 });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("ONLINE_SOURCE_UNAVAILABLE");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
