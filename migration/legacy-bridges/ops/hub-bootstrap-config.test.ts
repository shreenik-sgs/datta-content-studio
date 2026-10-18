import { describe, expect, it } from "vitest";
// @ts-expect-error deployment helper is deliberately runnable without TypeScript
import { bootstrapConfig } from "../packages/distribution-db/ops/bootstrap-config.mjs";

function fixture(target = "staging") {
  const host = "example.ap-south-1.rds.amazonaws.com";
  const url = (role: string) =>
    `postgres://distribution_${target}_${role}:${"a".repeat(64)}@${host}:5432/distribution_${target}?sslmode=verify-full`;
  return {
    DEPLOY_ENV: target,
    HUB_DATABASE_HOST: host,
    DISTRIBUTION_DATABASE_URL: url("runtime"),
    DISTRIBUTION_MIGRATION_DATABASE_URL: url("migrator"),
  };
}
describe("Hub bootstrap deployment boundary", () => {
  it("preserves staging and requires explicit production predeploy authorization", () => {
    expect(bootstrapConfig(fixture()).database).toBe("distribution_staging");
    expect(() => bootstrapConfig(fixture("production"))).toThrow("NOT_AUTHORIZED");
    expect(
      bootstrapConfig({ ...fixture("production"), HUB_PRODUCTION_BOOTSTRAP: "explicit-predeploy" })
        .database,
    ).toBe("distribution_production");
  });
  it("refuses mixed environments and core database or privileged role URLs", () => {
    const env = { ...fixture("production"), HUB_PRODUCTION_BOOTSTRAP: "explicit-predeploy" };
    for (const url of [
      fixture().DISTRIBUTION_DATABASE_URL,
      env.DISTRIBUTION_DATABASE_URL.replace("/distribution_production?", "/sgsdattasannidhi?"),
      env.DISTRIBUTION_DATABASE_URL.replace("production_runtime:", "production_migrator:"),
      env.DISTRIBUTION_DATABASE_URL.replace("verify-full", "require"),
      env.DISTRIBUTION_DATABASE_URL.replace(env.HUB_DATABASE_HOST, "other.rds.amazonaws.com"),
    ]) {
      expect(() => bootstrapConfig({ ...env, DISTRIBUTION_DATABASE_URL: url })).toThrow(
        "INVALID_HUB_DATABASE",
      );
    }
    expect(() => bootstrapConfig(fixture("unknown"))).toThrow("INVALID_DEPLOY_ENV");
  });
});
