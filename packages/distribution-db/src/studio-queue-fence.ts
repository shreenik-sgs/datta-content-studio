import type { PoolClient } from "pg";

// Shared by every generation/publication/import transaction. They still run in
// parallel. A series transition briefly takes the exclusive counterpart to make
// its global idle check and batch dispatch atomic, without broader DB privileges.
export const STUDIO_QUEUE_FENCE = "studio-queue-admission-v1";
export async function joinStudioQueueFence(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
    STUDIO_QUEUE_FENCE,
  ]);
}
