import { Pool } from "pg";
import { promoteGbadptClone } from "../../packages/distribution-db/src/studio-world-promotion";

async function main() {
  const env = process.env;
  if (
    env.STUDIO_IDENTITY !== "gbadpt" ||
    env.DISTRIBUTION_APP_ORIGIN !== "https://gbadpt.sgsdattasannidhi.org" ||
    env.DISTRIBUTION_HUB_STAGE !== "TEST" ||
    env.STUDIO_PUBLISHING_ENABLED !== "false"
  )
    throw Error("PROMOTION_WRONG_INSTALLATION");
  const url = new URL(env.STUDIO_PROMOTION_DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/datta_content_studio_gbadpt_live")
    throw Error("PROMOTION_WRONG_DATABASE");
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const client = await pool.connect();
    try {
      console.info(
        JSON.stringify(
          await promoteGbadptClone(client, {
            key: env.STUDIO_CHANNEL_CONFIG_KEY ?? "",
            apply: process.argv.includes("--apply"),
          }),
        ),
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error && /^PROMOTION_[A-Za-z_]+$/.test(error.message)
      ? error.message
      : "PROMOTION_FAILED_NO_CHANGES_COMMITTED",
  );
  process.exitCode = 1;
});
