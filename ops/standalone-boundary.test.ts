import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("contains only Hub workspace packages and no Sannidhi runtime dependencies", () => {
  const refs = JSON.parse(readFileSync("tsconfig.json", "utf8")).references as { path: string }[];
  expect(refs.every((ref) => ref.path.includes("distribution-"))).toBe(true);
  expect(existsSync("apps/web")).toBe(false);
  expect(existsSync("packages/db")).toBe(false);
  for (const path of [
    "apps/distribution-web/src/lib/auth.ts",
    "packages/distribution-db/src/studio-authority.ts",
  ])
    expect(readFileSync(path, "utf8")).not.toMatch(
      /DISTRIBUTION_CORE_ORIGIN|\/api\/v1\/operator-identity|ds_session=/,
    );
});
it("retains a patch whenever its exact target appears in the independent dependency graph", () => {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const key of [
    "braces@3.0.3",
    "decode-uri-component@0.5.0",
    "http-cache-semantics@4.3.0",
    "image-size@1.2.1",
    "node-forge@1.4.0",
  ])
    if (lock.includes(`  ${key}:`)) expect(pkg.pnpm.patchedDependencies[key], key).toBeTruthy();
});
