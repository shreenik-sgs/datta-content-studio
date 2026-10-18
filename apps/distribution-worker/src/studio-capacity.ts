/** Explicit deployment capacity, independent of curator count or number of open tabs. */
export function studioCapacity(env: Record<string, string | undefined>) {
  const raw = env.STUDIO_GENERATION_CONCURRENCY ?? "1";
  if (!/^[1-8]$/.test(raw)) throw Error("INVALID_STUDIO_GENERATION_CONCURRENCY");
  const generation = Number(raw);
  return { generation, queue: generation + 1, prefetch: generation + 2 };
}
