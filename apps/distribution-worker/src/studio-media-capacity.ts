/** Bound CPU-heavy work separately from provider requests. Two generation jobs can wait for
 * AI concurrently without running two full video encoders on a small server. */
export function studioMediaCapacity(env: Record<string, string | undefined>) {
  const value = env.STUDIO_MEDIA_PROCESS_CONCURRENCY ?? "1";
  if (!/^[1-4]$/.test(value)) throw Error("INVALID_STUDIO_MEDIA_CONCURRENCY");
  return Number(value);
}

export function createStudioMediaSlots(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4)
    throw Error("INVALID_STUDIO_MEDIA_CONCURRENCY");
  let active = 0;
  const queue: (() => void)[] = [];
  async function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw Error("RENDER_CANCELLED");
    if (active < limit) {
      active++;
      return;
    }
    return new Promise((resolve, reject) => {
      const remove = () => {
        signal?.removeEventListener("abort", cancel);
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
      };
      const cancel = () => {
        remove();
        reject(Error("RENDER_CANCELLED"));
      };
      const start = () => {
        remove();
        active++;
        resolve();
      };
      // The process ahead has its own deadline and progress watchdog. Waiting for
      // that process is not an encoding timeout. Keep FIFO order until capacity
      // is available or the generation lease/shutdown signal cancels this work.
      signal?.addEventListener("abort", cancel, { once: true });
      queue.push(start);
      if (signal?.aborted) cancel();
    });
  }
  return async function run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await acquire(signal);
    try {
      if (signal?.aborted) throw Error("RENDER_CANCELLED");
      return await operation();
    } finally {
      active--;
      queue[0]?.();
    }
  };
}
let shared: ReturnType<typeof createStudioMediaSlots> | undefined;
export function withStudioMediaSlot<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  shared ??= createStudioMediaSlots(studioMediaCapacity(process.env));
  return shared(operation, signal);
}
