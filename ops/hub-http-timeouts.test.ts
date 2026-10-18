import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("allows streaming large Hub uploads while preserving short header and idle limits", () => {
  const inspect =
    "const h=require('node:http'),s=h.createServer();console.log(JSON.stringify({request:s.requestTimeout,headers:s.headersTimeout,keepAlive:s.keepAliveTimeout}));s.close();";
  const env = { ...process.env };
  env.DISTRIBUTION_UPLOAD_REQUEST_TIMEOUT_MS = undefined;
  const baseline = JSON.parse(
    execFileSync(process.execPath, ["-e", inspect], { encoding: "utf8", env }),
  );
  for (const timeout of [undefined, "7200000"]) {
    const actual = JSON.parse(
      execFileSync(process.execPath, ["--require", "./ops/hub-http-timeouts.cjs", "-e", inspect], {
        encoding: "utf8",
        env: { ...env, ...(timeout ? { DISTRIBUTION_UPLOAD_REQUEST_TIMEOUT_MS: timeout } : {}) },
      }),
    );
    expect(actual).toEqual({ ...baseline, request: Number(timeout ?? 3600000) });
  }
  const docker = readFileSync("Dockerfile", "utf8");
  expect(docker).toContain(
    'CMD ["node", "--require", "./hub-http-timeouts.cjs", "apps/distribution-web/server.js"]',
  );
});

it.each(["0", "-1", "garbage", "7200001", "Infinity"])(
  "refuses unbounded or invalid Hub upload deadlines: %s",
  (timeout) => {
    const result = spawnSync(
      process.execPath,
      ["--require", "./ops/hub-http-timeouts.cjs", "-e", ""],
      {
        encoding: "utf8",
        env: { ...process.env, DISTRIBUTION_UPLOAD_REQUEST_TIMEOUT_MS: timeout },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVALID_HUB_UPLOAD_REQUEST_TIMEOUT");
  },
);
