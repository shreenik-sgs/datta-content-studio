// Loaded only by the standalone Hub web server. Node's five-minute whole-request
// deadline otherwise returns 408 during a valid, actively streaming master upload.
// Next's generated standalone launcher does not expose the HTTP server handle.
// Keep the normal header and idle limits; size/concurrency/auth guards remain in
// the upload routes, and the load balancer retains its idle timeout.
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");
const raw = process.env.DISTRIBUTION_UPLOAD_REQUEST_TIMEOUT_MS;
const timeout = raw === undefined ? 3600000 : Number(raw);
if (!Number.isSafeInteger(timeout) || timeout < 300000 || timeout > 7200000) {
  throw Error("INVALID_HUB_UPLOAD_REQUEST_TIMEOUT");
}
for (const transport of [http, https]) {
  const createServer = transport.createServer;
  transport.createServer = function (...args) {
    const server = Reflect.apply(createServer, this, args);
    server.requestTimeout = timeout;
    return server;
  };
}
syncBuiltinESMExports();
