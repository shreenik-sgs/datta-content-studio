import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const manifests = new Map<string, { path: string; value: Manifest }>();
for (const root of ["apps", "packages"]) {
  for (const folder of readdirSync(root, { withFileTypes: true }).filter((item) =>
    item.isDirectory(),
  )) {
    const path = join(root, folder.name);
    try {
      const value = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as Manifest;
      manifests.set(value.name, { path, value });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
const dockerfile = readFileSync("Dockerfile", "utf8");
const stages = new Map(
  [
    ...dockerfile.matchAll(/^FROM\s+(.+?)\s+AS\s+([\w-]+)\s*\n([\s\S]*?)(?=^FROM\s|$(?![\s\S]))/gm),
  ].map((match) => [match[2] as string, { base: match[1], body: match[3] as string }]),
);
function workspaceClosure(name: string, found = new Set<string>()): Set<string> {
  if (found.has(name)) return found;
  found.add(name);
  const manifest = manifests.get(name);
  if (!manifest) throw new Error(`Unknown workspace ${name}`);
  for (const [dependency, version] of Object.entries({
    ...manifest.value.dependencies,
    ...manifest.value.devDependencies,
  }))
    if (version.startsWith("workspace:")) workspaceClosure(dependency, found);
  return found;
}
function body(stage: string) {
  const result = stages.get(stage);
  if (!result) throw new Error(`Missing stage ${stage}`);
  return result.body;
}

describe("Distribution container dependency and release boundary", () => {
  it("includes every workspace manifest for a valid frozen install", () => {
    const stage = body("manifests");
    for (const manifest of manifests.values())
      expect(stage).toContain(`COPY ${manifest.path}/package.json ${manifest.path}/`);
  });
  for (const [stage, workspace] of [
    ["build-distribution-web", "@satsang/distribution-web"],
    ["distribution-worker", "@satsang/distribution-worker"],
    ["distribution-links", "@satsang/distribution-links"],
    ["distribution-migrate", "@satsang/distribution-db"],
  ]) {
    it(`${stage} includes the full transitive workspace source graph`, () => {
      const stageBody = body(stage as string);
      for (const name of workspaceClosure(workspace as string)) {
        const path = manifests.get(name)?.path;
        expect(stageBody).toContain(`COPY ${path} ${path}`);
      }
      expect(stageBody).toContain(`--filter "${workspace}..."`);
      expect(stageBody).toContain("--frozen-lockfile");
    });
  }
  it("keeps services independently runnable, non-root, default OFF, and migrations separate", () => {
    for (const stage of ["distribution-web", "distribution-worker", "distribution-links"]) {
      const stageBody = body(stage);
      expect(stageBody).toContain("USER node");
      expect(stageBody).toMatch(/DISTRIBUTION_(?:HUB|LINKS)_ENABLED=false/);
      expect(stageBody).toMatch(/DISTRIBUTION_(?:HUB|LINKS)_STAGE=OFF/);
      expect(stageBody).not.toMatch(/^(?:RUN|CMD|ENTRYPOINT).*\bmigrate\b/m);
    }
    const links = body("distribution-links");
    expect(links).not.toMatch(/^COPY (?:packages\/(?:distribution-)?db|apps\/distribution-web) /m);
    expect(links).not.toMatch(/^ENV .*DATABASE_URL/m);
    expect(body("distribution-migrate")).toContain(
      'CMD ["./node_modules/.bin/drizzle-kit", "migrate"]',
    );
    expect(body("distribution-migrate")).not.toMatch(
      /^(?:ARG|ENV) DISTRIBUTION_MIGRATION_DATABASE_URL=/m,
    );
  });
  it("ships the official content brand and the restricted online downloader", () => {
    expect(body("distribution-web")).toContain(
      "/repo/apps/distribution-web/public ./apps/distribution-web/public",
    );
    expect(body("distribution-studio")).toContain("yt-dlp[default]==2026.8.19");
    expect(body("distribution-studio")).toContain("/opt/brand/sgsswamiji.jpg");
  });
  it("includes reviewed migration SQL in build context without admitting dumps or local secrets", () => {
    const ignore = readFileSync(".dockerignore", "utf8").split(/\r?\n/);
    expect(ignore).toContain("*.sql");
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".env.*");
    for (const path of [
      "packages/db/drizzle/**/*.sql",
      "packages/distribution-db/drizzle/**/*.sql",
      "packages/distribution-db/ops/runtime-grants.sql",
    ]) {
      expect(ignore).toContain(`!${path}`);
      expect(ignore.indexOf(`!${path}`)).toBeGreaterThan(ignore.indexOf("*.sql"));
    }
    expect(ignore).not.toContain("!**/*.sql");
    expect(ignore).not.toContain("!.env.local");
  });
});
