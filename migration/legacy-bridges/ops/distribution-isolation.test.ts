import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const coreRoots = [
  "apps/web/src",
  "apps/mobile/src",
  "apps/fanout/src",
  "apps/worker/src",
  "packages/domain/src",
  "packages/db/src",
  "packages/media/src",
  "packages/mcp/src",
];

function sourceFiles(directory: string): string[] {
  if (!statSync(directory, { throwIfNoEntry: false })) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx|js|mjs)$/.test(name)
        ? [path]
        : [];
  });
}

describe("DS-DIST-R0 dependency boundary", () => {
  it("DS-DIST-R0-09 keeps core source independent of Distribution Hub packages", () => {
    const violations = coreRoots
      .flatMap(sourceFiles)
      .filter((file) => readFileSync(file, "utf8").includes("@satsang/distribution-"));
    expect(violations).toEqual([]);
  });
});
