export type CleanupSelection = {
  kind: "package" | "master" | "playlist";
  id: string;
  mode: "generated" | "all";
};
export type CleanupFile = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName?: string;
};
export type CleanupPreview = {
  selection: CleanupSelection;
  title: string;
  token: string;
  masterCount: number;
  packageCount: number;
  fileCount: number;
  bytes: number;
  sharedFileCount: number;
  blockers: string[];
};
/** Walk only persisted asset descriptors; arbitrary filenames/URLs are never deletion targets. */
export function cleanupFiles(value: unknown): CleanupFile[] {
  const files = new Map<string, CleanupFile>();
  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (
      typeof item.storageKey === "string" &&
      typeof item.sha256 === "string" &&
      typeof item.byteSize === "number" &&
      typeof item.mimeType === "string"
    ) {
      if (
        !/^distribution\/(masters|studio|derived|renders)\//.test(item.storageKey) ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.byteSize) ||
        item.byteSize < 1
      )
        throw Error("INVALID_CLEANUP_ASSET");
      const asset: CleanupFile = {
        storageKey: item.storageKey,
        sha256: item.sha256,
        byteSize: item.byteSize,
        mimeType: item.mimeType,
        ...(typeof item.originalName === "string" ? { originalName: item.originalName } : {}),
      };
      const prior = files.get(asset.storageKey);
      if (prior && (prior.sha256 !== asset.sha256 || prior.byteSize !== asset.byteSize))
        throw Error("INVALID_CLEANUP_ASSET");
      files.set(asset.storageKey, asset);
    }
    for (const nested of Object.values(node)) visit(nested);
  }
  visit(value);
  return [...files.values()].sort((a, b) => a.storageKey.localeCompare(b.storageKey));
}
export function cleanupAllowed(input: {
  reviewer: boolean;
  userId: string;
  owner: string;
  statuses: string[];
}) {
  return (
    input.reviewer ||
    (input.userId === input.owner &&
      input.statuses.every((status) =>
        ["DRAFT", "CHANGES_REQUESTED", "FAILED", "DISCARDED", "QUEUED"].includes(status),
      ))
  );
}
