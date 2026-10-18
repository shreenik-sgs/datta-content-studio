/** Validate the separate Hub database before opening any connection. */
export function bootstrapConfig(env) {
  const target = env.DEPLOY_ENV;
  if (target !== "staging" && target !== "production") throw Error("INVALID_DEPLOY_ENV");
  if (target === "production" && env.HUB_PRODUCTION_BOOTSTRAP !== "explicit-predeploy")
    throw Error("PRODUCTION_BOOTSTRAP_NOT_AUTHORIZED");
  const database = `distribution_${target}`;
  const migrator = `${database}_migrator`;
  const runtime = `${database}_runtime`;
  const runtimeUrl = new URL(env.DISTRIBUTION_DATABASE_URL);
  const migrationUrl = new URL(env.DISTRIBUTION_MIGRATION_DATABASE_URL);
  for (const [url, role] of [
    [runtimeUrl, runtime],
    [migrationUrl, migrator],
  ]) {
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.pathname !== `/${database}` ||
      url.username !== role ||
      !url.hostname.endsWith(".rds.amazonaws.com") ||
      url.hostname !== env.HUB_DATABASE_HOST ||
      !/^[a-f0-9]{64}$/.test(url.password) ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      (url.port && url.port !== "5432") ||
      url.hash
    )
      throw Error("INVALID_HUB_DATABASE");
  }
  return { target, database, migrator, runtime, runtimeUrl, migrationUrl };
}
