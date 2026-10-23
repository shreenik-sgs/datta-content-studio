"use client";
import {
  DISTRIBUTION_LANGUAGE_NAMES,
  contentMasterSchema,
  distributionText,
} from "@satsang/distribution-contracts";
import {
  CONTENT_CATEGORIES,
  type ContentMaster,
  type DistributionCapability,
  ONLINE_IMPORT_ERRORS,
  type OnlineImport,
  isOnlineBundle,
  onlineVideoBundle,
  onlineVideoSource,
} from "@satsang/distribution-domain";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ImportRecovery } from "./import-recovery";
import { PlaylistCuration } from "./playlist-curation";
import { StorageCleanup } from "./storage-cleanup";
import { StudioPanel } from "./studio-panel";
import { WorkspaceName } from "./workspace-name";
const API = "/distribution/api/content/import";
export function OnlineImportPanel({
  locale,
  showForm,
  onOpen,
  capabilities = ["content.create"],
  completeOnly = false,
  onGroupedMasters,
  onBundleSelection,
  initialBundleId,
}: {
  locale: string;
  showForm: boolean;
  onOpen: (content: ContentMaster, packageId?: string) => void;
  capabilities?: readonly DistributionCapability[];
  completeOnly?: boolean;
  onGroupedMasters?: (ids: string[]) => void;
  onBundleSelection?: (open: boolean) => void;
  initialBundleId?: string | undefined;
}) {
  const [seriesMode, setSeriesMode] = useState(false);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selectedBundle, setSelectedBundle] = useState<string | null>(initialBundleId ?? null);
  const [reviewing, setReviewing] = useState(Boolean(initialBundleId));
  const canCurate = capabilities.includes("content.create");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [items, setItems] = useState<OnlineImport[]>([]);
  const [error, setError] = useState("");
  const [progressError, setProgressError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const params = new URLSearchParams(
        selectedBundle
          ? { rootId: selectedBundle }
          : { offset: String(offset), ...(query ? { query } : {}) },
      );
      const response = await fetch(`${API}?${params}`, {
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error("Unable to load online imports. Please refresh.");
      const data = await response.json();
      setItems(data.items ?? []);
      setNextOffset(data.nextOffset ?? null);
      onGroupedMasters?.(data.groupedMasterIds ?? []);
      setAvailable(data.available);
      setProgressError("");
    },
    [onGroupedMasters, selectedBundle, offset, query],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await load(abort.signal);
      } catch {
        if (!abort.signal.aborted)
          setProgressError(
            "Unable to check import progress. Reconnecting automatically; your bundle is saved.",
          );
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [load]);
  async function send(data: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    let safeMessage =
      "The Hub could not confirm this request. It may already be queued. Refresh the bundle before retrying; your existing sources and drafts are retained.";
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(30000),
      });
      const body = await response.json();
      if (!response.ok) {
        safeMessage =
          ONLINE_IMPORT_ERRORS[body.error] ??
          "The Hub could not apply this action. Refresh the bundle and check its current status before retrying.";
        throw Error("IMPORT_REQUEST_REJECTED");
      }
      setActiveImportId((previous) =>
        ["import", "import-bundle"].includes((data as { action?: string }).action ?? "")
          ? body.item.id
          : (previous ?? body.item.parentId ?? body.item.id),
      );
      setItems((previous) =>
        previous.some((item) => item.id === body.item.id) ? previous : [body.item, ...previous],
      );
      if (isOnlineBundle(body.item.source)) setSelectedBundle(body.item.id);
      setNotice(
        (data as { action?: string }).action === "resume-playlist"
          ? "Playlist recovery requested for unfinished downloads and retryable generation. Recordings needing source review, completed drafts and approved outputs are preserved."
          : body.item.curation
            ? "Shared settings saved. Each video will move into curation automatically as its download completes."
            : isOnlineBundle(body.item.source) && body.item.childIds?.length
              ? "Bundle found. Set permissions and generation options once below."
              : body.item.status === "COMPLETE"
                ? "This source is already imported. Open its existing master below."
                : body.item.status === "FAILED"
                  ? "This source has an earlier failed import. Use Retry below."
                  : "Import queued. You can leave this page and return under Continue Existing Curation.",
      );
      // A successful mutation must remain successful even if its follow-up read fails.
      await load().catch(() =>
        setProgressError(
          "Your request was saved, but progress could not refresh. Reconnecting automatically; do not submit it again.",
        ),
      );
    } catch {
      setError(safeMessage);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const url = String(form.get("url") ?? "");
    const includePlaylist = form.get("includePlaylist") === "on";
    if (seriesMode) {
      const urls = String(form.get("urls") ?? "");
      try {
        onlineVideoBundle(urls);
      } catch (error) {
        setError(
          ONLINE_IMPORT_ERRORS[error instanceof Error ? error.message : ""] ??
            "Check the video links. Use one valid YouTube or Facebook video link per line.",
        );
        return;
      }
      void send({
        action: "import-bundle",
        urls,
        title: form.get("title"),
        language: form.get("language"),
        category: form.get("category"),
      });
      return;
    }
    try {
      onlineVideoSource(url, includePlaylist);
    } catch {
      setError(ONLINE_IMPORT_ERRORS.UNSUPPORTED_VIDEO_LINK ?? "");
      return;
    }
    void send({
      action: "import",
      ...(String(form.get("title") ?? "").trim()
        ? { title: String(form.get("title")).trim() }
        : {}),
      url,
      includePlaylist,
      language: form.get("language"),
      category: form.get("category"),
    });
  }
  async function open(id: string, packageId?: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/distribution/api/content/${id}/detail`, { cache: "no-store" });
      if (!response.ok) throw Error("Unable to open the master. Please refresh.");
      onOpen(contentMasterSchema.parse((await response.json()).content), packageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open master.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    onBundleSelection?.(Boolean(selectedBundle));
  }, [selectedBundle, onBundleSelection]);
  const membership = new Set(items.flatMap((item) => item.childIds ?? []));
  const complete = (item: OnlineImport) =>
    Boolean(
      item.childIds?.length &&
        item.curation &&
        !item.curation.pausedForCleanup &&
        !Object.values(item.curation.items).some((member) => member.error === "CONTENT_REMOVED") &&
        item.childIds.every((id) =>
          ["APPROVED", "DISCARDED"].includes(item.curation?.items[id]?.status ?? ""),
        ),
    );
  const visibleItems = items.filter((item) =>
    showForm
      ? item.id === activeImportId
      : selectedBundle
        ? item.id === selectedBundle
        : isOnlineBundle(item.source)
          ? completeOnly === complete(item)
          : !completeOnly &&
            !item.parentId &&
            !membership.has(item.id) &&
            item.status !== "COMPLETE",
  );
  const reviewItem = items.find((item) => item.id === selectedBundle);
  if (selectedBundle && !reviewItem)
    return (
      <section className="panel" aria-label="Series files">
        <p role={progressError ? "alert" : "status"}>
          {progressError ||
            (available === null
              ? "Loading series files…"
              : "This playlist or series is no longer available in this workspace.")}
        </p>
        <button
          className="button"
          type="button"
          onClick={() => {
            setSelectedBundle(null);
            setReviewing(false);
          }}
        >
          Back to sources
        </button>
      </section>
    );
  if (reviewing && reviewItem?.curation)
    return (
      <StudioPanel
        capabilities={capabilities}
        {...(completeOnly ? { scope: "complete" as const } : {})}
        bundle={{
          totalRecordings: reviewItem.childIds?.length ?? 0,
          title: reviewItem.title ?? "Playlist",
          playlistId: reviewItem.id,
          sourceLinks: Object.fromEntries(
            (reviewItem.childIds ?? []).flatMap((id) => {
              const child = items.find((value) => value.id === id);
              return child?.masterId && child.source?.url
                ? [[child.masterId, child.source.url]]
                : [];
            }),
          ),
          masterIds: (reviewItem.childIds ?? []).flatMap((id) => {
            const child = items.find((value) => value.id === id);
            return child?.masterId ? [child.masterId] : [];
          }),
          packageIds: Object.values(reviewItem.curation.items).flatMap((member) =>
            member.packageId ? [member.packageId] : [],
          ),
        }}
        onOpenSource={(id, packageId) => void open(id, packageId)}
        onRenameBundle={
          canCurate ? (
            <WorkspaceName
              kind="import"
              id={reviewItem.id}
              title={reviewItem.title ?? "Playlist"}
              name={reviewItem.workspaceName}
              onSaved={load}
            />
          ) : undefined
        }
        onBackToBundle={() => setReviewing(false)}
      />
    );
  if (
    !showForm &&
    !query &&
    !visibleItems.length &&
    !error &&
    !progressError &&
    offset === 0 &&
    !nextOffset
  )
    return null;
  return (
    <section className="panel" aria-label="Online video imports">
      {!showForm && (
        <>
          <h2>
            {selectedBundle
              ? "Bundle workspace"
              : completeOnly
                ? "Completed playlists and series"
                : "Playlists and series"}
          </h2>
          <p>
            One bundle, one setup and one workspace. Downloads and generation continue
            automatically.
          </p>
          {selectedBundle && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setSelectedBundle(null);
                setReviewing(false);
              }}
            >
              Back to sources
            </button>
          )}
        </>
      )}
      {showForm && !selectedBundle && (
        <form onSubmit={submit}>
          <h2>Import from YouTube or Facebook</h2>
          <p>
            Paste a video or YouTube playlist link. Each video becomes a master for creating channel
            content. Playlists support up to 100 recordings, downloaded one at a time. Online
            recordings can be up to 2 GB each.
          </p>
          <fieldset disabled={busy}>
            <label>
              Source type
              <select
                value={seriesMode ? "series" : "link"}
                onChange={(event) => {
                  setSeriesMode(event.target.value === "series");
                  setError("");
                }}
              >
                <option value="link">One video or YouTube playlist</option>
                <option value="series">Series of video links</option>
              </select>
            </label>
            <label>
              {seriesMode ? "Series name" : "Playlist or video name (optional)"}
              <input
                name="title"
                required={seriesMode}
                maxLength={200}
                placeholder="e.g. Sri Vishnu Purana"
              />
            </label>
            {!seriesMode && (
              <p className="muted">
                Leave blank to use the original title. You can rename it later.
              </p>
            )}
            {seriesMode ? (
              <>
                <label>
                  Video links — one per line
                  <textarea
                    name="urls"
                    required
                    rows={8}
                    maxLength={205000}
                    placeholder="https://www.youtube.com/watch?v=…"
                  />
                </label>
                <p className="muted">
                  Paste up to 100 videos in episode order, from the same provider. Duplicate links
                  reuse their existing master. Set permissions and generation options once for the
                  whole series on the next screen.
                </p>
              </>
            ) : (
              <>
                <label>
                  Video or playlist link
                  <input
                    name="url"
                    type="url"
                    required
                    maxLength={2048}
                    placeholder="https://www.youtube.com/watch?v=…"
                  />
                </label>
                <label className="online-import-checkbox">
                  <input name="includePlaylist" type="checkbox" defaultChecked /> Import every video
                  in this YouTube playlist
                </label>
                <p className="muted">
                  Playlist links include all videos by default. Clear this only to import a single
                  video from a link that also contains a playlist.
                </p>
              </>
            )}
            <div className="fields">
              <label>
                Spoken language
                <select
                  name="language"
                  defaultValue={locale in DISTRIBUTION_LANGUAGE_NAMES ? locale : "en"}
                >
                  {Object.entries(DISTRIBUTION_LANGUAGE_NAMES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select name="category" defaultValue="pravachanams">
                  {CONTENT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {distributionText(locale, value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="muted">
              Use recordings you are authorized to curate. Private, members-only, or login-required
              videos need an authorized file upload. A public link does not grant publishing rights.
            </p>
            {available === false && (
              <p>
                Online imports are temporarily unavailable. Upload a file, or return when the
                download service is running.
              </p>
            )}
            <button className="button primary" type="submit" disabled={!available}>
              {busy
                ? "Starting import…"
                : available === null
                  ? "Checking download service…"
                  : "Next: Import source"}
            </button>
          </fieldset>
        </form>
      )}
      {!showForm && !selectedBundle && (
        <form
          className="actions wrap"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setQuery(String(new FormData(event.currentTarget).get("query") ?? "").trim());
          }}
        >
          <label>
            Find a playlist or series
            <input
              type="search"
              name="query"
              maxLength={200}
              defaultValue={query}
              placeholder="Search by name"
            />
          </label>
          <button className="button" type="submit">
            Search
          </button>
        </form>
      )}
      {!showForm && !selectedBundle && query && !visibleItems.length && (
        <p>No sources match this name.</p>
      )}
      {progressError && <output>{progressError}</output>}
      {error && (
        <p role="alert" style={{ color: "#a52245" }}>
          {error}
        </p>
      )}
      {notice && <output>{notice}</output>}
      {selectedBundle && (
        <StorageCleanup
          key={`cleanup-playlist-${selectedBundle}`}
          kind="playlist"
          id={selectedBundle}
          onDeleted={() => {
            setSelectedBundle(null);
            setReviewing(false);
          }}
        />
      )}
      {!selectedBundle && !showForm && (offset > 0 || nextOffset !== null) && (
        <div className="actions wrap">
          <button
            className="button"
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous playlists
          </button>
          <button
            className="button"
            type="button"
            disabled={nextOffset === null}
            onClick={() => nextOffset !== null && setOffset(nextOffset)}
          >
            Next playlists
          </button>
        </div>
      )}
      {visibleItems.length > 0 && (
        <details open>
          <summary>
            {selectedBundle
              ? "Curation bundle"
              : `Sources · ${visibleItems.length} ${visibleItems.length === 1 ? "bundle" : "bundles"}`}
          </summary>
          <ul>
            {visibleItems.map((item) => (
              <li key={item.id}>
                {item.source.kind === "bundle" ? (
                  <strong>{item.title ?? "Video series"}</strong>
                ) : (
                  <a href={item.source.url} target="_blank" rel="noreferrer">
                    {item.title ??
                      `${item.source.provider} ${item.source.kind} · ${item.source.id}`}
                  </a>
                )}
                {canCurate && (
                  <WorkspaceName
                    kind="import"
                    id={item.id}
                    title={item.title ?? "Untitled source"}
                    name={item.workspaceName}
                    onSaved={load}
                  />
                )}
                {isOnlineBundle(item.source) ? (
                  !showForm && selectedBundle !== item.id ? (
                    <div>
                      <p>
                        {item.childIds?.length ?? "Reading"} recordings ·{" "}
                        {item.serviceIssue
                          ? "Import service needs attention"
                          : complete(item)
                            ? "Approved"
                            : item.curation
                              ? "Curation in progress"
                              : "Ready for shared setup"}
                      </p>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => setSelectedBundle(item.id)}
                      >
                        {item.source.kind === "bundle" ? "Continue series" : "Continue playlist"}
                      </button>
                    </div>
                  ) : !item.childIds?.length ? (
                    <div aria-live="polite">
                      <p>
                        {item.serviceIssue
                          ? ONLINE_IMPORT_ERRORS[item.serviceIssue.code]
                          : item.status === "FAILED"
                            ? (ONLINE_IMPORT_ERRORS[item.error ?? ""] ??
                              "Unable to read this playlist.")
                            : "Reading the playlist. Shared setup will appear here once its recordings are found."}
                      </p>
                      {canCurate && (
                        <ImportRecovery key={item.id} item={item} items={items} onSaved={load} />
                      )}
                      {canCurate &&
                        item.serviceIssue?.code !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED" &&
                        item.error !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED" &&
                        (item.status === "FAILED" || item.serviceIssue) && (
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy || Boolean(item.serviceIssue?.retryAt)}
                            onClick={() => void send({ action: "resume-playlist", id: item.id })}
                          >
                            {item.serviceIssue ? "Retry blocked downloads" : "Resume playlist"}
                          </button>
                        )}
                    </div>
                  ) : (
                    <PlaylistCuration
                      completeOnly={completeOnly}
                      item={item}
                      items={items}
                      busy={busy}
                      send={send}
                      open={open}
                      canCurate={canCurate}
                      canReview={capabilities.includes("content.review")}
                      onReview={() => setReviewing(true)}
                      onReload={load}
                    />
                  )
                ) : (
                  <div>
                    <p>
                      {item.serviceIssue
                        ? ONLINE_IMPORT_ERRORS[item.serviceIssue.code]
                        : item.status === "QUEUED"
                          ? "Waiting to download"
                          : item.status === "DOWNLOADING"
                            ? "Downloading recording…"
                            : item.status === "FAILED"
                              ? (ONLINE_IMPORT_ERRORS[item.error ?? ""] ??
                                "Import failed. Retry or upload the recording.")
                              : "Master ready"}
                    </p>
                    {canCurate && (
                      <ImportRecovery key={item.id} item={item} items={items} onSaved={load} />
                    )}
                  </div>
                )}
                {item.masterId && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => void open(item.masterId as string)}
                  >
                    Continue to permissions
                  </button>
                )}
                {(item.status === "FAILED" || item.serviceIssue) &&
                  !isOnlineBundle(item.source) &&
                  item.serviceIssue?.code !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED" &&
                  item.error !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED" &&
                  canCurate && (
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() => void send({ action: "retry", id: item.id })}
                    >
                      {item.serviceIssue ? "Retry blocked download" : "Retry import"}
                    </button>
                  )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
