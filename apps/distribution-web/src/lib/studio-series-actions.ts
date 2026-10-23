import type {
  ContentMaster,
  StudioChannel,
  StudioRetractionResult,
} from "@satsang/distribution-domain";
import type { PublicStudioPackage, PublicStudioPublication, StudioDetail } from "./studio-model";
import { STUDIO_PUBLICATION_LABELS, studioMessage } from "./studio-model";

export type SeriesAction = "submit" | "approve" | "post" | "retract";
export type SeriesRow = {
  id: string;
  detail: StudioDetail;
  title: string;
  count: number;
  outputId?: string;
  publication?: PublicStudioPublication;
  source?: ContentMaster | undefined;
  blocker?: string | undefined;
};
export type SeriesResult = {
  id: string;
  title: string;
  message: string;
  ok: boolean;
  remoteUrl?: string | null;
  channel?: StudioChannel;
};

export async function seriesRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  let data: T & { error?: string };
  try {
    response = await fetch(path, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    data = await response.json();
  } catch {
    throw Error(body === undefined ? "STUDIO_SERIES_LOAD_FAILED" : "STUDIO_ACTION_UNCONFIRMED");
  }
  if (!response.ok) throw Error(data.error ?? "STUDIO_ACTION_UNCONFIRMED");
  return data;
}

export const seriesActionName = {
  submit: "Submit",
  approve: "Approve",
  post: "Post",
  retract: "Retract",
};
export function seriesCandidates(packages: readonly PublicStudioPackage[], action: SeriesAction) {
  return packages.filter(
    (p) =>
      action === "retract" ||
      (p.outputs.some((o) => o.included) &&
        (action === "submit"
          ? ["DRAFT", "CHANGES_REQUESTED"].includes(p.status)
          : p.status === (action === "approve" ? "IN_REVIEW" : "APPROVED"))),
  );
}

export async function prepareSeriesRows(
  packages: readonly PublicStudioPackage[],
  action: SeriesAction,
): Promise<SeriesRow[]> {
  const rows: SeriesRow[] = [];
  const candidates = seriesCandidates(packages, action);
  // On-demand, bounded reads; no channel polling and no mutation during selection.
  for (let i = 0; i < candidates.length; i += 4) {
    const chunk = await Promise.all(
      candidates.slice(i, i + 4).map(async (pkg) => {
        const detail = await seriesRequest<StudioDetail>(`/distribution/api/studio/${pkg.id}`);
        const current = detail.package;
        if (!seriesCandidates([current], action).length) return [];
        const outputs = current.outputs.filter((o) => o.included);
        if (action === "retract")
          return detail.publications
            .filter((p) => p.status !== "CANCELLED")
            .map((p) => ({
              id: p.id,
              detail,
              title:
                current.outputs.find((o) => o.id === p.outputId)?.asset?.filename ??
                current.source.title,
              count: 1,
              publication: p,
            }));
        const blockers = detail.blockers.filter(
          (code) => action === "post" || code !== "NOT_APPROVED",
        );
        if (action === "submit" && outputs.some((o) => o.correction?.state === "pending"))
          blockers.push("STUDIO_CORRECTIONS_PENDING");
        const blocker = blockers.length ? blockers.map(studioMessage).join(" ") : undefined;
        if (action === "post")
          return outputs.map((o) => {
            const previous = detail.publications.find(
              (p) => p.outputId === o.id && p.packageRevision === current.revision,
            );
            return {
              id: o.id,
              detail,
              title: o.asset?.filename ?? o.title,
              count: 1,
              outputId: o.id,
              blocker:
                blocker ??
                (previous && previous.status !== "BLOCKED"
                  ? "A posting request already exists. Check its result before sending again."
                  : undefined),
            };
          });
        const source =
          action === "approve"
            ? (
                await seriesRequest<{ content: ContentMaster }>(
                  `/distribution/api/content/${current.source.masterId}/detail`,
                )
              ).content
            : undefined;
        return [
          {
            id: current.id,
            detail,
            title: current.source.title,
            count: outputs.length,
            source,
            blocker:
              blocker ??
              (source && !["APPROVED", "PUBLISHED", "RIGHTS_CLEARED"].includes(source.state)
                ? "Master permissions must be completed by the Curator first."
                : undefined),
          },
        ];
      }),
    );
    rows.push(...chunk.flat());
  }
  return rows;
}

const retractionMessages: Record<StudioRetractionResult, string> = {
  CANCELLED: "Retracted from Studio. Local file and review history retained.",
  ALREADY_CANCELLED: "Already retracted; nothing further was changed.",
  REMOVE_ON_CHANNEL:
    "Still published. Buffer cannot remove the video from the channel. Remove it in the channel's own Studio.",
  CHECK_CHANNEL:
    "Removal not confirmed. A send may already be in progress. Check the channel before taking further action.",
};

/** One transaction per recording; report each outcome and stop on an ambiguous response. */
export async function runSeriesAction(
  action: SeriesAction,
  rows: readonly SeriesRow[],
  accounts: Partial<Record<StudioChannel, string>>,
  onResult: (result: SeriesResult) => void,
) {
  const groups = new Map<string, SeriesRow[]>();
  for (const row of rows) {
    if (row.blocker) throw Error("INVALID_STUDIO_OUTPUT_SELECTION");
    groups.set(row.detail.package.id, [...(groups.get(row.detail.package.id) ?? []), row]);
  }
  for (const group of groups.values()) {
    const row = group[0];
    if (!row) continue;
    const pkg = row.detail.package;
    const base = `/distribution/api/studio/${pkg.id}`;
    let sourceApproved = false;
    try {
      if (action === "approve" && row.source?.state === "RIGHTS_CLEARED") {
        await seriesRequest(`/distribution/api/content/${row.source.id}/approve`, {
          expectedRevision: row.source.revision,
        });
        sourceApproved = true;
      }
      if (action === "retract") {
        const data = await seriesRequest<{
          results: { publication: PublicStudioPublication; result: StudioRetractionResult }[];
        }>(`${base}/retract`, {
          expectedRevision: pkg.revision,
          publicationIds: group.map((r) => r.publication?.id),
        });
        for (const entry of data.results)
          onResult({
            id: entry.publication.id,
            title: group.find((r) => r.id === entry.publication.id)?.title ?? row.title,
            ok: ["CANCELLED", "ALREADY_CANCELLED"].includes(entry.result),
            message: retractionMessages[entry.result],
            remoteUrl: entry.publication.remoteUrl,
            channel: entry.publication.channel,
          });
      } else {
        const response = await seriesRequest<{ publications?: PublicStudioPublication[] }>(
          `${base}/${action === "approve" ? "review" : action === "post" ? "publish" : "submit"}`,
          {
            expectedRevision: pkg.revision,
            ...(action === "approve"
              ? { decision: "APPROVED", confirmTranscript: true, confirmTeachingIntegrity: true }
              : {}),
            ...(action === "post"
              ? {
                  outputIds: group.map((r) => r.outputId),
                  accounts: Object.fromEntries(
                    Object.entries(accounts).filter(([channel]) =>
                      pkg.outputs.some(
                        (o) => o.channel === channel && group.some((r) => r.outputId === o.id),
                      ),
                    ),
                  ),
                }
              : {}),
          },
        );
        if (
          action === "post" &&
          group.some(
            (item) =>
              !response.publications?.some(
                (p) => p.outputId === item.outputId && p.packageRevision === pkg.revision,
              ),
          )
        )
          throw Error("STUDIO_ACTION_UNCONFIRMED");
        for (const item of group) {
          if (action === "post") {
            const job = response.publications?.find(
              (p) => p.outputId === item.outputId && p.packageRevision === pkg.revision,
            );
            if (!job) throw Error("STUDIO_ACTION_UNCONFIRMED");
            onResult({
              id: item.id,
              title: item.title,
              ok: ["QUEUED", "RUNNING", "PROCESSING", "SIMULATED", "PUBLISHED"].includes(
                job.status,
              ),
              message:
                job.status === "QUEUED"
                  ? pkg.isTest
                    ? "Test publication queued. Nothing is sent to a channel."
                    : "Queued for posting after the duplicate check. This is not a delivery confirmation."
                  : `${STUDIO_PUBLICATION_LABELS[job.status]}${job.error ? `: ${studioMessage(job.error)}` : ""}`,
              remoteUrl: job.remoteUrl,
            });
          } else
            onResult({
              id: item.id,
              title: item.title,
              ok: true,
              message:
                action === "submit"
                  ? "Submitted for Approver review."
                  : "Approved; posting is a separate action.",
            });
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "STUDIO_ACTION_UNCONFIRMED";
      for (const item of group)
        onResult({
          id: item.id,
          title: item.title,
          ok: false,
          message: `${sourceApproved ? "Master permissions approved; file approval did not complete. " : ""}${studioMessage(code)}`,
        });
      if (["STUDIO_ACTION_UNCONFIRMED", "FORBIDDEN", "UNAUTHORIZED"].includes(code)) break;
    }
  }
}
