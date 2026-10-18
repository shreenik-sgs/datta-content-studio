"use client";
import { LiveCurationEntry } from "./live/entry";

import {
  DISTRIBUTION_LANGUAGE_NAMES,
  contentMasterSchema,
  contentRightsSchema,
  distributionErrorText,
  distributionText,
} from "@satsang/distribution-contracts";
import type { DistributionTextKey } from "@satsang/distribution-contracts";
import {
  CONTENT_CATEGORIES,
  type ContentMaster,
  type DistributionCapability,
  STUDIO_CHANNELS,
  buildMasterAssetNames,
  studioChannelLabel,
} from "@satsang/distribution-domain";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  MasterUploadBusyError,
  MasterUploadDuplicateError,
  MasterUploadSizeError,
  uploadMaster,
} from "../lib/master-upload";
import { EditorialPanel } from "./editorial-panel";
import { NativePanel } from "./native-panel";
import { OnlineImportPanel } from "./online-import-panel";
import { OutreachPanel } from "./outreach-panel";
import { StorageCleanup } from "./storage-cleanup";
import { StudioPanel } from "./studio-panel";
import { StudioWorkflow } from "./studio-workflow";
import { VariantsPanel } from "./variants-panel";

import {
  type RightsErrors,
  type RightsField,
  rightsErrors,
  rightsFields,
} from "../lib/rights-errors";

const API = "/distribution/api/content";
type Props = {
  locale: string;
  displayName: string | null;
  capabilities: DistributionCapability[];
  stage: string;
  analyticsEnabled?: boolean;
  initialMasterId?: string | undefined;
  initialStudioPackageId?: string | undefined;
  initialView?: "content" | "studio" | "complete";
};
type View = "content" | "approvals" | "releases" | "campaigns" | "studio" | "complete";
const viewLabels: Record<View, string> = {
  studio: "Continue Existing Curation",
  content: "Start New Curation",
  complete: "Curation Complete Library",
  approvals: "Source approvals",
  releases: "Approved masters",
  campaigns: "Campaigns",
};
function supportsGeneration(content: ContentMaster) {
  return (
    content.currentVersion.mimeType === "video/mp4" ||
    content.currentVersion.mimeType.startsWith("audio/")
  );
}
function localDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Mark({ kind }: { kind: string }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "audio" ? (
        <>
          <path d="M9 18V5l11-2v13M9 8l11-2" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="17" cy="16" r="3" />
        </>
      ) : kind === "video" ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="m10 8 6 4-6 4Z" />
        </>
      ) : kind === "image" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="m3 17 6-6 4 4 3-3 5 5" />
          <circle cx="16" cy="8" r="1" />
        </>
      ) : (
        <>
          <path d="M7 3h7l5 5v13H5V3Z M14 3v6h5 M8 13h8 M8 17h5" />
        </>
      )}
    </svg>
  );
}

export function ContentLibrary({
  locale,
  capabilities,
  analyticsEnabled = false,
  initialView,
  initialMasterId,
  initialStudioPackageId,
}: Props) {
  const t = useCallback((key: DistributionTextKey) => distributionText(locale, key), [locale]);
  const [items, setItems] = useState<ContentMaster[]>([]);
  const [selected, setSelected] = useState<ContentMaster | null>(null);
  const contentWorkflow =
    capabilities.includes("content.create") || capabilities.includes("content.review");
  const [view, setView] = useState<View>(initialView ?? (contentWorkflow ? "studio" : "content"));
  const [search, setSearch] = useState("");
  const archive = "active" as const;
  const [initialPackageId, setInitialPackageId] = useState<string | undefined>();
  useEffect(() => {
    if (!initialMasterId) return;
    const abort = new AbortController();
    void fetch(`/distribution/api/content/${encodeURIComponent(initialMasterId)}/detail`, {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error("Unable to open the selected source.");
        const data = await response.json();
        setSelected(contentMasterSchema.parse(data.content));
        setInitialPackageId(initialStudioPackageId);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Unable to open the selected source. Return to its broadcast and retry.");
      });
    return () => abort.abort();
  }, [initialMasterId, initialStudioPackageId]);
  const [adding, setAdding] = useState(false);
  const [packageOpen, setPackageOpen] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  const [groupedMasterIds, setGroupedMasterIds] = useState<string[]>([]);
  const [liveMasterIds, setLiveMasterIds] = useState<string[]>([]);
  const liveMastersLoaded = useCallback((ids: string[]) => setLiveMasterIds(ids), []);
  const [groupsReady, setGroupsReady] = useState(false);
  const groupedMastersLoaded = useCallback((ids: string[]) => {
    setGroupedMasterIds(ids);
    setGroupsReady(true);
  }, []);
  const [workspaceVisit, setWorkspaceVisit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [permissionErrors, setPermissionErrors] = useState<RightsErrors>({});
  const permissionForm = useRef<HTMLFormElement>(null);
  function showPermissionErrors(fields: RightsErrors) {
    setPermissionErrors(fields);
    setError("");
  }
  useEffect(() => {
    if (busy) return;
    const field = Object.keys(permissionErrors)[0] as RightsField | undefined;
    if (!field) return;
    const form = permissionForm.current;
    const details = form?.closest("details");
    if (details) details.open = true;
    form?.querySelector<HTMLElement>(`[name="${rightsFields[field].name}"]`)?.focus();
    form?.scrollIntoView({ block: "center" });
  }, [permissionErrors, busy]);
  const permissionAttributes = (field: RightsField) => ({
    style: permissionErrors[field] ? { borderColor: "#a52245" } : undefined,
    "aria-invalid": Boolean(permissionErrors[field]),
    "aria-describedby": permissionErrors[field] ? `permission-${field}-error` : undefined,
  });
  const permissionError = (field: RightsField) =>
    permissionErrors[field] ? (
      <span id={`permission-${field}-error`} style={{ color: "#a52245" }}>
        {permissionErrors[field]}
      </span>
    ) : null;
  // A different master must not inherit the previous master’s form errors.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on master identity changes
  useEffect(() => {
    setPermissionErrors({});
  }, [selected?.id]);
  const [uploadLimit, setUploadLimit] = useState<number | null>(null);
  const [uploadPolicyError, setUploadPolicyError] = useState("");
  const canUpload = capabilities.includes("content.create");
  const loadUploadPolicy = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${API}/upload-policy`, {
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error("UNAVAILABLE");
      const policy = await response.json();
      if (signal?.aborted) return;
      setUploadLimit(policy.maxMasterBytes);
      setUploadPolicyError("");
    } catch {
      if (!signal?.aborted)
        setUploadPolicyError("Unable to load the upload limit. Retry before uploading.");
    }
  }, []);
  useEffect(() => {
    if (!canUpload) return;
    const abort = new AbortController();
    void loadUploadPolicy(abort.signal);
    return () => abort.abort();
  }, [canUpload, loadUploadPolicy]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const loadGeneration = useRef(0);
  const can = (cap: DistributionCapability) => capabilities.includes(cap);
  const load = useCallback(
    async (offset = 0) => {
      const generation = ++loadGeneration.current;
      if (view === "content" || view === "campaigns" || view === "studio" || view === "complete")
        return;
      if (!offset) setLoading(true);
      try {
        setError("");
        const response = await fetch(
          `${API}?${new URLSearchParams({ offset: String(offset), query: search, view, archive })}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("LOAD_FAILED");
        const result = await response.json();
        const incoming = contentMasterSchema.array().parse(result.items);
        if (generation !== loadGeneration.current) return;
        setItems((previous) => (offset ? [...previous, ...incoming] : incoming));
        setNextOffset(result.nextOffset);
      } catch {
        if (generation === loadGeneration.current) setError(t("error"));
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [t, search, view, archive],
  );
  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timeout);
  }, [load]);
  useEffect(() => {
    if (selected?.id || adding) heading.current?.focus();
  }, [selected?.id, adding]);

  async function send(action: string, data: unknown) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/${selected.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: selected.revision, ...(data as object) }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({ error: "UNAVAILABLE" }));
        if (action === "rights" && problem.fields && Object.keys(problem.fields).length) {
          showPermissionErrors(problem.fields);
          return;
        }
        if (response.status === 409) await refreshSelected();
        throw new Error(problem.error);
      }
      if (action === "export") {
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = buildMasterAssetNames({
          masterId: selected.id,
          versionNumber: selected.currentVersion.number,
        }).archive;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const content = contentMasterSchema.parse((await response.json()).content);
        setSelected(content);
        setItems((previous) => previous.map((item) => (item.id === content.id ? content : item)));
      }
      if (action === "rights") setPermissionErrors({});
      setConfirming(false);
    } catch (problem) {
      setError(
        problem instanceof MasterUploadSizeError ||
          problem instanceof MasterUploadDuplicateError ||
          problem instanceof MasterUploadBusyError
          ? problem.message
          : distributionErrorText(
              locale,
              problem instanceof Error ? problem.message : "UNAVAILABLE",
            ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function refreshSelected() {
    if (!selected) return;
    const response = await fetch(`${API}/${selected.id}/detail`, { cache: "no-store" });
    if (response.ok) {
      const content = contentMasterSchema.parse((await response.json()).content);
      setSelected(content);
      setItems((previous) => previous.map((item) => (item.id === content.id ? content : item)));
    }
  }
  async function replaceSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    form.set("expectedRevision", String(selected.revision));
    setBusy(true);
    setError("");
    try {
      const response = await uploadMaster(`${API}/${selected.id}/version`, form, uploadLimit ?? 0);
      const content = contentMasterSchema.parse((await response.json()).content);
      setSelected(content);
      setItems((previous) => previous.map((item) => (item.id === content.id ? content : item)));
    } catch (error) {
      setError(
        error instanceof MasterUploadSizeError ||
          error instanceof MasterUploadDuplicateError ||
          error instanceof MasterUploadBusyError
          ? error.message
          : distributionErrorText(locale, error instanceof Error ? error.message : "UNAVAILABLE"),
      );
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await uploadMaster(API, new FormData(event.currentTarget), uploadLimit ?? 0);
      const result = await response.json();
      const content = contentMasterSchema.parse(result.content);
      setItems((previous) => [content, ...previous]);
      setAdding(false);
      setSelected(content);
      setInitialPackageId(result.studioPackage?.id);
      if (result.studioError)
        setError(
          "Your master was saved. Confirm its permissions, then generate a channel package when the service is ready. You do not need to upload it again.",
        );
    } catch (problem) {
      setError(
        problem instanceof MasterUploadSizeError ||
          problem instanceof MasterUploadDuplicateError ||
          problem instanceof MasterUploadBusyError
          ? problem.message
          : distributionErrorText(
              locale,
              problem instanceof Error ? problem.message : "UNAVAILABLE",
            ),
      );
    } finally {
      setBusy(false);
    }
  }
  function rights(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const date = (key: string) => {
      const value = String(data.get(key) ?? "");
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
    };
    const parsed = contentRightsSchema.safeParse({
      owner: data.get("owner"),
      authorizationBasis: data.get("authorization"),
      territories: String(data.get("territories"))
        .split(",")
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean),
      channels: data.getAll("rightsChannel"),
      privacyClass: data.get("privacy"),
      releaseAt: date("release"),
      expiresAt: date("expiry"),
    });
    if (!parsed.success) {
      showPermissionErrors(rightsErrors(parsed.error.issues));
      return;
    }
    setPermissionErrors({});
    void send("rights", { rights: parsed.data });
  }

  const visible = items.filter(
    (item) =>
      item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
      ((view === "content" && item.state !== "WITHDRAWN") ||
        (view === "approvals" && item.state === "RIGHTS_CLEARED") ||
        (view === "releases" && item.state === "APPROVED")),
  );
  function reset() {
    setAdding(false);
    setSelected(null);
    setInitialPackageId(undefined);
    setPackageOpen(false);
    setBundleOpen(false);
    setConfirming(false);
    setError("");
  }
  function focusWorkspace() {
    const target = document.getElementById(adding ? "upload-master-form" : "curation-workspace");
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }
  const entryWorkflow = (
    <StudioWorkflow
      value={undefined}
      starting={view === "content" || adding}
      hasMaster={false}
      permissionsReady={false}
      publications={[]}
      nextLabel={
        adding ? "choose a file" : view === "content" ? "choose your source" : "open a curation"
      }
      nextDisabled={view === "content" && !can("content.create")}
      onNext={focusWorkspace}
      onStep={() => {
        setView("content");
        window.setTimeout(focusWorkspace, 0);
      }}
    />
  );

  return (
    <main className="shell" lang={locale}>
      <header className="topbar">
        {analyticsEnabled && (
          <a className="button" href="/distribution/analytics">
            Analytics
          </a>
        )}
      </header>
      <div className={selected || adding ? "page-heading compact-heading" : "visually-hidden"}>
        <h1 ref={heading} tabIndex={-1}>
          {adding ? "Upload master" : selected ? selected.title : viewLabels[view]}
        </h1>
        {(selected || adding) && (
          <button type="button" className="button" onClick={reset}>
            Back to workspace
          </button>
        )}
      </div>
      {selected && (
        <StorageCleanup
          key={`cleanup-master-${selected.id}`}
          kind="master"
          id={selected.id}
          onDeleted={() => {
            setSelected(null);
            setPackageOpen(false);
            setWorkspaceVisit((v) => v + 1);
          }}
        />
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button
            type="button"
            onClick={() => {
              void load();
              void refreshSelected();
            }}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {uploadPolicyError && (adding || (selected && !packageOpen)) && (
        <div className="notice error" role="alert">
          {uploadPolicyError}
          <button type="button" onClick={() => void loadUploadPolicy()}>
            Retry upload settings
          </button>
        </div>
      )}
      {!adding && !selected && (
        <>
          <div className="library-tools workspace-tabs-frame">
            <nav className="tabs primary-tabs" aria-label={t("hub")}>
              {(["content", "studio", "complete"] as const).map((tab) => (
                <button
                  type="button"
                  key={tab}
                  aria-current={view === tab ? "page" : undefined}
                  onClick={(event) => {
                    setView(tab);
                    setPackageOpen(false);
                    setBundleOpen(false);
                    setWorkspaceVisit((visit) => visit + 1);
                    event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                  }}
                >
                  {viewLabels[tab]}
                </button>
              ))}
            </nav>
            {view !== "content" &&
              view !== "campaigns" &&
              view !== "studio" &&
              view !== "complete" && (
                <input
                  type="search"
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              )}
          </div>
          {view === "content" && !bundleOpen && entryWorkflow}
          <div id="curation-workspace" className="workspace-content">
            {!adding && !selected && contentWorkflow && view === "content" && (
              <section className="panel">
                <h2>Curate live programs</h2>
                <p>
                  Monitor the channels configured for Content Studio and collect complete teachings
                  as each program happens.
                </p>
                <a className="button" href="/distribution/live">
                  Set up live monitoring
                </a>
              </section>
            )}
            {view === "studio" && !packageOpen && !bundleOpen && (
              <LiveCurationEntry onGroupedMasters={liveMastersLoaded} />
            )}

            {!adding && !selected && can("content.create") && view === "content" && (
              <OnlineImportPanel
                locale={locale}
                showForm={view === "content"}
                capabilities={capabilities}
                onBundleSelection={setBundleOpen}
                onOpen={(content, packageId) => {
                  setInitialPackageId(packageId);
                  setSelected(content);
                  setError("");
                }}
              />
            )}
            {(view === "studio" || view === "complete") && !packageOpen && !bundleOpen && (
              <section className="panel source-chooser-heading">
                <h2>{view === "complete" ? "Completed sources" : "Choose a source to continue"}</h2>
                <p className="workspace-intro">
                  {view === "complete"
                    ? "Approved files are locked. The Content Approver handles posting."
                    : "Select a playlist or series to work on all its recordings together, or choose an individual master below."}
                </p>
                <a href="/distribution/storage">Storage cleanup history</a>
              </section>
            )}
            {(view === "studio" || view === "complete") && !packageOpen && contentWorkflow && (
              <OnlineImportPanel
                key={view}
                locale={locale}
                showForm={false}
                capabilities={capabilities}
                completeOnly={view === "complete"}
                onGroupedMasters={groupedMastersLoaded}
                onBundleSelection={setBundleOpen}
                onOpen={(content, packageId) => {
                  setInitialPackageId(packageId);
                  setSelected(content);
                  setError("");
                }}
              />
            )}
            {view !== "content" &&
              view !== "studio" &&
              view !== "complete" &&
              view !== "campaigns" && (
                <section className="library-explanation" aria-label="About master files">
                  <h2>
                    {view === "approvals"
                      ? "Approve the original source"
                      : view === "releases"
                        ? "Approved source files"
                        : "Choose an existing master"}
                  </h2>
                  <p>
                    This library contains original source recordings, one entry per master.
                    Generated channel files and ongoing curations are in Continue Existing Curation.
                    Choose an existing recording to start or continue curation without uploading it
                    again.
                  </p>
                  <details>
                    <summary>What do the master statuses mean?</summary>
                    <p>
                      Rights confirmed means the source permissions were recorded. Approved means a
                      Content Approver approved the original source. Each generated channel package
                      still needs its own review. Withdrawn masters are retained as history and
                      cannot be used for new generation.
                    </p>
                  </details>
                </section>
              )}
            {view === "content" ? (
              bundleOpen ? null : can("content.create") ? (
                <section className="panel" aria-label="Upload a master file">
                  <h2>Or upload a file</h2>
                  <p>Choose a recording saved on your computer.</p>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      setAdding(true);
                      setError("");
                    }}
                  >
                    Upload raw master
                  </button>
                  <p className="muted">
                    Already imported or uploaded? Open its workspace in Continue Existing Curation
                    or Curation Complete Library.
                  </p>
                </section>
              ) : (
                <section className="panel" aria-label="Content Curator access required">
                  <h2>Content Curator access required</h2>
                  <p>
                    Importing YouTube videos, Facebook videos, playlists or files requires the
                    Content Curator role. Your current account does not have that role. An
                    administrator can assign it in user management; one person can hold both Content
                    Curator and Content Approver roles.
                  </p>
                  {can("content.review") && (
                    <button className="button" type="button" onClick={() => setView("studio")}>
                      Review existing curations
                    </button>
                  )}
                </section>
              )
            ) : (view === "studio" || view === "complete") && !contentWorkflow ? (
              <section className="panel">
                <h2>Curation roles required</h2>
                <p>
                  Assign Content Curator to create content or Content Approver to review it.
                  Optional administration tools are available below.
                </p>
              </section>
            ) : view === "studio" || view === "complete" ? (
              bundleOpen ? null : !groupsReady ? (
                <output>Loading workspace…</output>
              ) : (
                <StudioPanel
                  key={`${view}-${workspaceVisit}`}
                  excludedMasterIds={[...groupedMasterIds, ...liveMasterIds]}
                  scope={view === "complete" ? "complete" : "ongoing"}
                  onChooseSource={() => setView("content")}
                  capabilities={capabilities}
                  onSelectionChange={setPackageOpen}
                  onOpenSource={(id, packageId) => {
                    void fetch(`${API}/${id}/detail`, { cache: "no-store" })
                      .then(async (response) => {
                        if (!response.ok) throw new Error("unavailable");
                        setInitialPackageId(packageId);
                        setPackageOpen(false);
                        setSelected(contentMasterSchema.parse((await response.json()).content));
                        window.setTimeout(
                          () =>
                            document
                              .getElementById(`source-${id}`)
                              ?.scrollIntoView({ block: "start" }),
                          100,
                        );
                      })
                      .catch(() => setError(t("error")));
                  }}
                />
              )
            ) : view === "campaigns" ? (
              <OutreachPanel locale={locale} capabilities={capabilities} />
            ) : loading ? (
              <output>{t("loading")}</output>
            ) : visible.length ? (
              <div className="library-grid">
                {visible.map((item) => (
                  <button
                    type="button"
                    className="content-card"
                    key={item.id}
                    onClick={() => {
                      setInitialPackageId(undefined);
                      setSelected(item);
                      setError("");
                    }}
                  >
                    <div className={`media-mark ${item.currentVersion.mimeType.split("/")[0]}`}>
                      <Mark kind={item.currentVersion.mimeType.split("/")[0] ?? "file"} />
                      <span className="badge">Master: {t(item.state)}</span>
                    </div>
                    <div className="card-body">
                      <h2>{item.title}</h2>
                      <p>
                        {DISTRIBUTION_LANGUAGE_NAMES[
                          item.language as keyof typeof DISTRIBUTION_LANGUAGE_NAMES
                        ] ?? item.language}
                        <span aria-hidden="true"> · </span>
                        {t("version")} {item.currentVersion.number}
                      </p>
                      <span className="card-next">
                        {item.state === "WITHDRAWN"
                          ? "View history"
                          : supportsGeneration(item)
                            ? "Open master & channel content →"
                            : "View source details →"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <section className="empty">
                <Mark kind="file" />
                <h2>
                  {t(
                    view === "approvals"
                      ? "emptyApprovalsTitle"
                      : view === "releases"
                        ? "emptyExportsTitle"
                        : "emptyTitle",
                  )}
                </h2>
                <p>
                  {t(
                    view === "approvals"
                      ? "emptyApprovalsBody"
                      : view === "releases"
                        ? "emptyExportsBody"
                        : "emptyBody",
                  )}
                </p>
              </section>
            )}
            {view !== "campaigns" &&
              view !== "studio" &&
              view !== "complete" &&
              view !== "content" &&
              nextOffset !== null && (
                <button className="button" type="button" onClick={() => void load(nextOffset)}>
                  {t("showAll")}
                </button>
              )}
          </div>
          {!packageOpen &&
            view !== "content" &&
            (can("content.review") ||
              can("content.publish") ||
              can("campaigns.manage") ||
              can("operations.manage")) && (
              <details className="workspace-tools">
                <summary>
                  More tools
                  {!["studio", "content", "complete"].includes(view)
                    ? ` · ${viewLabels[view]}`
                    : ""}
                </summary>
                <p>
                  Optional source libraries and outreach tools. The six-step curation workflow
                  handles creating, reviewing and publishing your channel content.
                </p>
                <div className="workspace-tool-cards">
                  {can("content.review") && (
                    <section>
                      <button className="button" type="button" onClick={() => setView("approvals")}>
                        Source approvals
                      </button>
                      <p>
                        Review original recordings and permissions. Generated files are reviewed in
                        step 4.
                      </p>
                    </section>
                  )}
                  {can("content.publish") && (
                    <section>
                      <button className="button" type="button" onClick={() => setView("releases")}>
                        Approved masters
                      </button>
                      <p>
                        Browse approved original recordings. Approved channel outputs are in
                        Curation Complete Library.
                      </p>
                    </section>
                  )}
                  {(can("campaigns.manage") || can("operations.manage")) && (
                    <section>
                      <button className="button" type="button" onClick={() => setView("campaigns")}>
                        Campaigns
                      </button>
                      <p>
                        Group outreach around an initiative and manage invitations to practices,
                        rooms or activities.
                      </p>
                    </section>
                  )}
                </div>
              </details>
            )}
        </>
      )}
      {adding && entryWorkflow}
      {adding && (
        <form id="upload-master-form" className="panel editor workspace-section" onSubmit={create}>
          <p>Choose your original recording.</p>
          <p>
            Choose a video or audio file from your computer. After confirming permissions, generate
            suitable content for all {STUDIO_CHANNELS.length} supported destinations from this one
            master.
          </p>
          <p className="muted">
            Next, confirm the source permissions before external AI processes it. Images and PDFs
            can be saved as reference files; automatic channel generation currently uses video and
            audio.
          </p>
          <fieldset disabled={busy}>
            <label>
              {t("title")}
              <input name="title" required maxLength={200} autoComplete="off" />
            </label>
            <div className="fields">
              <label>
                {t("language")}
                <select
                  name="language"
                  defaultValue={locale in DISTRIBUTION_LANGUAGE_NAMES ? locale : "en"}
                >
                  {Object.entries(DISTRIBUTION_LANGUAGE_NAMES).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("category")}
                <select name="category">
                  {CONTENT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="upload">
              {t("file")}
              <input
                name="file"
                type="file"
                required
                accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4,video/mp4,application/pdf"
              />
              <small>
                {uploadLimit === null
                  ? "Loading upload limit…"
                  : `Audio, video, image or PDF · Up to ${uploadLimit / 1024 / 1024} MB`}
              </small>
            </label>
            <div className="actions">
              <button type="submit" className="button primary" disabled={uploadLimit === null}>
                {busy ? "Uploading master…" : "Upload master and continue"}
              </button>
              <button type="button" className="button" onClick={reset}>
                {t("cancel")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {selected && selected.state !== "WITHDRAWN" && supportsGeneration(selected) && (
        <StudioPanel
          key={`studio-${selected.id}-${initialPackageId ?? "list"}`}
          content={selected}
          initialPackageId={initialPackageId}
          onSelectionChange={setPackageOpen}
          capabilities={capabilities}
          onOpenSource={() => {
            const source = document.getElementById(`source-${selected.id}`);
            if (source instanceof HTMLDetailsElement) source.open = true;
            permissionForm.current?.scrollIntoView({ block: "center" });
            permissionForm.current
              ?.querySelector<HTMLElement>("input")
              ?.focus({ preventScroll: true });
          }}
        />
      )}
      {selected && (
        <details
          open={!packageOpen}
          id={`source-${selected.id}`}
          tabIndex={-1}
          className="source-section"
          aria-label="Master file and permissions"
        >
          <summary>Master file and permissions</summary>
          {selected.sourceUrl && (
            <p>
              Original source:{" "}
              <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
                {selected.sourceUrl}
              </a>
            </p>
          )}
          <div className="actions wrap">
            {supportsGeneration(selected) && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  const studio = document.getElementById(`studio-${selected.id}`);
                  studio?.scrollIntoView({ block: "start" });
                  studio?.querySelector<HTMLHeadingElement>("h2")?.focus({ preventScroll: true });
                }}
              >
                Back to channel files
              </button>
            )}
          </div>
          <p className="muted">
            These permissions apply to the original source. Content Approver approval of the
            generated channel package is a separate step.
          </p>
          <div className="detail-grid">
            <section className="panel preview-panel" aria-label={t("contentPreview")}>
              <div className="preview">
                {selected.state === "WITHDRAWN" ? (
                  <p>{t("WITHDRAWN")}</p>
                ) : selected.currentVersion.mimeType.startsWith("image/") ? (
                  <img src={`${API}/${selected.id}/media`} alt={selected.title} />
                ) : selected.currentVersion.mimeType.startsWith("audio/") ? (
                  // biome-ignore lint/a11y/useMediaCaption: This private original is reviewed before captions are authored.
                  <audio controls src={`${API}/${selected.id}/media`} />
                ) : selected.currentVersion.mimeType.startsWith("video/") ? (
                  // biome-ignore lint/a11y/useMediaCaption: This private original is reviewed before captions are authored.
                  <video controls playsInline src={`${API}/${selected.id}/media`} />
                ) : (
                  <a
                    href={`${API}/${selected.id}/media`}
                    target="_blank"
                    rel="noreferrer"
                    className="button"
                  >
                    {t("contentPreview")}
                  </a>
                )}
              </div>
              <div className="preview-meta">
                <span className="badge">{t(selected.state)}</span>
                <span>
                  {t("version")} {selected.currentVersion.number}
                </span>
              </div>
              <p className="filename">{selected.currentVersion.originalName}</p>
              {(selected.currentVersion.mimeType === "video/mp4" ||
                selected.currentVersion.mimeType.startsWith("audio/")) &&
                selected.state !== "WITHDRAWN" && (
                  <a className="button" href={`#studio-${selected.id}`}>
                    Back to channel content
                  </a>
                )}
              <details>
                <summary>{t("checksum")}</summary>
                <code className="checksum">{selected.currentVersion.sha256}</code>
              </details>
              {can("content.create") && selected.state !== "WITHDRAWN" && (
                <details
                  className="editor-details"
                  key={`edit-${selected.id}-${selected.revision}`}
                >
                  <summary>{t("editDetails")}</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void send("metadata", {
                        title: data.get("title"),
                        language: data.get("language"),
                        category: data.get("category"),
                      });
                    }}
                  >
                    <fieldset disabled={busy}>
                      <label>
                        {t("title")}
                        <input
                          name="title"
                          required
                          maxLength={200}
                          defaultValue={selected.title}
                        />
                      </label>
                      <label>
                        {t("language")}
                        <select name="language" defaultValue={selected.language}>
                          {Object.entries(DISTRIBUTION_LANGUAGE_NAMES).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t("category")}
                        <select name="category" defaultValue={selected.category}>
                          {CONTENT_CATEGORIES.map((value) => (
                            <option key={value} value={value}>
                              {t(value)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="submit" className="button">
                        {t("save")}
                      </button>
                    </fieldset>
                  </form>
                  <form onSubmit={replaceSource}>
                    <fieldset disabled={busy}>
                      <label>
                        {t("newVersion")}
                        <input
                          type="file"
                          name="file"
                          required
                          accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4,video/mp4,application/pdf"
                        />
                      </label>
                      <button type="submit" className="button">
                        {t("save")}
                      </button>
                    </fieldset>
                  </form>
                </details>
              )}
              {selected.state !== "WITHDRAWN" && (
                <div className="actions wrap">
                  {can("content.review") &&
                    selected.state === "RIGHTS_CLEARED" &&
                    !supportsGeneration(selected) && (
                      <button
                        type="button"
                        disabled={busy}
                        className="button primary"
                        onClick={() => void send("approve", {})}
                      >
                        {t("approve")}
                      </button>
                    )}
                  {can("content.publish") && selected.state === "APPROVED" && (
                    <form
                      className="export-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void send("export", {
                          channel: "manual_export",
                          territory: data.get("territory"),
                        });
                      }}
                    >
                      <label>
                        {t("territories")}
                        <input
                          aria-label={t("territories")}
                          name="territory"
                          pattern="[A-Z]{2}"
                          maxLength={2}
                          minLength={2}
                          placeholder="IN"
                          required
                        />
                      </label>
                      <button type="submit" disabled={busy} className="button primary">
                        {t("manualExport")}
                      </button>
                    </form>
                  )}
                  {can("content.review") && (
                    <button
                      className="button quiet"
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(true)}
                    >
                      {t("withdraw")}
                    </button>
                  )}
                </div>
              )}
              {confirming && (
                <div className="confirm" role="alert">
                  <p>{t("confirmWithdraw")}</p>
                  <div className="actions">
                    <button
                      type="button"
                      className="button danger"
                      disabled={busy}
                      onClick={() => void send("withdraw", {})}
                    >
                      {t("withdraw")}
                    </button>
                    <button type="button" className="button" onClick={() => setConfirming(false)}>
                      {t("cancel")}
                    </button>
                  </div>
                </div>
              )}
            </section>
            <form
              className="panel"
              ref={permissionForm}
              noValidate
              onSubmit={rights}
              key={`${selected.id}-${selected.revision}`}
            >
              {Object.keys(permissionErrors).length > 0 && (
                <div role="alert" className="notice" style={{ display: "block" }}>
                  <strong>Permissions were not saved. Fix these fields:</strong>
                  <ul>
                    {(Object.keys(permissionErrors) as RightsField[]).map((field) => (
                      <li key={field}>
                        <button
                          type="button"
                          className="button"
                          style={{ whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }}
                          onClick={() =>
                            permissionForm.current
                              ?.querySelector<HTMLElement>(`[name="${rightsFields[field].name}"]`)
                              ?.focus()
                          }
                        >
                          {rightsFields[field].label}: {permissionErrors[field]}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <h2>{t("rights")}</h2>
              {!selected.rights && (
                <p>
                  Defaults are filled in for Ashrama-owned recordings: worldwide public distribution
                  on all supported channels, with no date restrictions. Review or change them for
                  this master. Saving confirms that you have this authorization; these defaults are
                  not saved automatically.
                </p>
              )}
              <fieldset disabled={busy || !can("content.create") || selected.state === "WITHDRAWN"}>
                <label>
                  {t("owner")}
                  <input
                    name="owner"
                    {...permissionAttributes("owner")}
                    defaultValue={selected.rights?.owner ?? "Sri Ganapathy Sachchidananda Ashrama"}
                    required
                    maxLength={200}
                  />
                  {permissionError("owner")}
                </label>
                <label>
                  {t("authorization")}
                  <textarea
                    name="authorization"
                    {...permissionAttributes("authorizationBasis")}
                    defaultValue={
                      selected.rights?.authorizationBasis ??
                      "Ashrama authorization for AI-assisted editing, translation, subtitles, and distribution of this recording through the selected channels."
                    }
                    required
                    maxLength={2000}
                    rows={3}
                  />
                  {permissionError("authorizationBasis")}
                </label>
                <label>
                  {t("territories")}
                  <input
                    name="territories"
                    {...permissionAttributes("territories")}
                    defaultValue={selected.rights?.territories.join(", ") ?? "WORLDWIDE"}
                    placeholder="WORLDWIDE or IN, US"
                    required
                  />
                  {permissionError("territories")}
                </label>
                <label>
                  {t("privacy")}
                  <select
                    name="privacy"
                    {...permissionAttributes("privacyClass")}
                    defaultValue={selected.rights?.privacyClass ?? "PUBLIC"}
                  >
                    <option value="INTERNAL">{t("internal")}</option>
                    <option value="PUBLIC">{t("public")}</option>
                    <option value="RESTRICTED">{t("restricted")}</option>
                  </select>
                  {permissionError("privacyClass")}
                </label>
                <div className="fields">
                  <label>
                    {t("releaseDate")}
                    <input
                      type="datetime-local"
                      name="release"
                      {...permissionAttributes("releaseAt")}
                      defaultValue={localDateTime(selected.rights?.releaseAt)}
                    />
                    {permissionError("releaseAt")}
                  </label>
                  <label>
                    {t("expiryDate")}
                    <input
                      type="datetime-local"
                      name="expiry"
                      {...permissionAttributes("expiresAt")}
                      defaultValue={localDateTime(selected.rights?.expiresAt)}
                    />
                    {permissionError("expiresAt")}
                  </label>
                </div>
                <fieldset>
                  <legend>Allowed publication channels</legend>
                  {permissionError("channels")}
                  <p className="muted">
                    Choose every platform the Ashrama permits for this source. Creating a draft does
                    not grant publication rights.
                  </p>
                  <div className="fields">
                    {["manual_export", ...STUDIO_CHANNELS].map((channel) => (
                      <label
                        key={channel}
                        style={{ flexDirection: "row", alignItems: "start", minHeight: 44 }}
                      >
                        <input
                          type="checkbox"
                          name="rightsChannel"
                          {...permissionAttributes("channels")}
                          value={channel}
                          defaultChecked={
                            selected.rights?.channels.some((allowed) => allowed === channel) ?? true
                          }
                          style={{
                            width: 18,
                            height: 18,
                            minHeight: 18,
                            marginTop: 2,
                            flexShrink: 0,
                          }}
                        />
                        {channel === "manual_export"
                          ? "Manual export package"
                          : studioChannelLabel(channel as (typeof STUDIO_CHANNELS)[number])}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {can("content.create") && selected.state !== "WITHDRAWN" && (
                  <button type="submit" className="button">
                    {busy ? t("loading") : t("saveRights")}
                  </button>
                )}
              </fieldset>
            </form>
          </div>
        </details>
      )}
      {selected && !packageOpen && selected.state !== "WITHDRAWN" && (
        <details className="panel workspace-tools">
          <summary>Advanced tools — optional</summary>
          <p>
            Not needed for the six-step curation workflow. These tools support specialist editorial
            review and imports.
          </p>
          <EditorialPanel content={selected} locale={locale} capabilities={capabilities} />
          <NativePanel key={selected.id} content={selected} capabilities={capabilities} />
        </details>
      )}
      {selected && !packageOpen && (
        <details className="panel workspace-tools">
          <summary>Upload externally edited versions — optional</summary>
          <p>
            Use this only for files prepared in another editor. For AI-generated channel files, use
            the curation workflow above; corrections there apply only to the files returned by the
            Approver.
          </p>
          <VariantsPanel
            key={selected.id}
            content={selected}
            locale={locale}
            capabilities={capabilities}
          />
        </details>
      )}
    </main>
  );
}
