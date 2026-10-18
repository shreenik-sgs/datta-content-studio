import { rm } from "node:fs/promises";
import {
  type DerivedPrivateAsset,
  type PrivateAssetStore,
  createPrivateAssetStore,
} from "@satsang/distribution-assets";
import {
  type LocalRenderResult,
  createLocalRenderer,
  createPrivateRenderScratch,
} from "./renderer.js";

type LocalRenderer = ReturnType<typeof createLocalRenderer>;
type Options = {
  store: PrivateAssetStore;
  scratchRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs?: number;
  overallTimeoutMs?: number;
};
const descriptors = (result: LocalRenderResult) => [
  result.video,
  ...(result.captions ? [result.captions] : []),
  result.manifest,
];
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("RENDER_CANCELLED");
};

/** Storage-neutral encoder adapter. FFmpeg only sees verified private local snapshots. */
export function createStoredRenderer(options: Options): LocalRenderer {
  // Validate private root and executable configuration before any storage request.
  createLocalRenderer({ ...options, root: options.scratchRoot });
  // Each storage operation has a 30-second bound. A 180-second orchestration
  // budget leaves one in-flight operation and the metadata commit inside the
  // existing 240-second queue lease, without extending that lease.
  const overallTimeoutMs = options.overallTimeoutMs ?? 180000;
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 10 || overallTimeoutMs > 180000)
    throw new Error("INVALID_RENDER_TIMEOUT");
  const owned = new WeakMap<LocalRenderResult, DerivedPrivateAsset[]>();
  return {
    async render(input) {
      cancelled(input.signal);
      const source = { ...input.source, originalName: "master.mp4" };
      const budget = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, budget.signal]) : budget.signal;
      const deadline = performance.now() + overallTimeoutMs;
      const timer = setTimeout(() => budget.abort(), overallTimeoutMs);
      const check = () => {
        cancelled(input.signal);
        if (budget.signal.aborted || performance.now() >= deadline) {
          budget.abort();
          throw new Error("RENDER_TIMEOUT");
        }
      };
      let scratch: string | undefined;
      const confirmed: DerivedPrivateAsset[] = [];
      let scratchRemoved = false;
      try {
        scratch = await createPrivateRenderScratch(options.scratchRoot);
        check();
        const localStore = createPrivateAssetStore(scratch);
        const bytes = await options.store.read(source);
        check();
        const staged = await localStore.write({
          bytes,
          mimeType: source.mimeType,
          originalName: source.originalName,
        });
        const result = await createLocalRenderer({ ...options, root: scratch }).render({
          ...input,
          source: {
            ...source,
            storageKey: staged.storageKey,
            originalStorageKey: source.storageKey,
          },
          signal,
        });
        // Recheck the durable source after encoding before releasing any derivative.
        check();
        await options.store.read(source);
        check();
        for (const descriptor of descriptors(result)) {
          check();
          const bytes = await localStore.readDerivedDescriptor(descriptor);
          check();
          await options.store.writeDerivedDescriptor(descriptor, bytes);
          // Only a confirmed immutable create is ours to remove. A failed put can have
          // succeeded remotely, so its uncertain object is deliberately left untouched.
          confirmed.push({ ...descriptor });
        }
        check();
        await rm(scratch, { recursive: true, force: true });
        scratchRemoved = true;
        check();
        owned.set(result, confirmed);
        return result;
      } catch (error) {
        const failure = budget.signal.aborted ? new Error("RENDER_TIMEOUT") : error;
        await Promise.allSettled(
          confirmed.map((descriptor) => options.store.removeDerivedUnreferenced(descriptor)),
        );
        throw failure;
      } finally {
        clearTimeout(timer);
        if (scratch && !scratchRemoved) await rm(scratch, { recursive: true, force: true });
      }
    },
    async discard(result) {
      const expected = owned.get(result);
      if (!expected || JSON.stringify(descriptors(result)) !== JSON.stringify(expected))
        throw new Error("INVALID_RENDER_RESULT");
      // runRenderJob invokes this only after a definitive repository rejection. A lost
      // commit acknowledgement preserves all uploaded output for later reconciliation.
      const deleted = await Promise.allSettled(
        expected.map((descriptor) => options.store.removeDerivedUnreferenced(descriptor)),
      );
      if (deleted.some((entry) => entry.status === "rejected"))
        throw new Error("RENDER_RESULT_CLEANUP_FAILED");
      owned.delete(result);
    },
  };
}
