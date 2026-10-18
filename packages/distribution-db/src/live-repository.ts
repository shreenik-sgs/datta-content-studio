import { randomUUID } from "node:crypto";
import {
  LIVE_CURATION_ERRORS,
  type LiveCurationBroadcast,
  type LiveCurationMonitor,
  type LiveCurationSettings,
  liveCurationWindow,
  validateLiveCurationSettings,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  type DistributionContext,
  type PrivateAsset,
  distributionWorld,
  insertContentMaster,
  recordContentRights,
  requireDistributionCapability,
} from "./repository";
import type { StudioRoleAuthority } from "./studio-authority";
import { loadStudioSource } from "./studio-source";
export type LiveFragment = {
  sequence: number;
  durationMs: number;
  sha256: string;
  byteSize: number;
  key: string;
};
export type LiveCaptureState = {
  nextSequence: number | null;
  buffers: LiveFragment[];
  offsetMs: number;
  capturedMs: number;
  windowNumber: number;
  capturedFrom: string | null;
};
export type LiveMonitorClaim = {
  id: string;
  isTest: boolean;
  revision: number;
  requestedBy: string;
  settings: LiveCurationSettings;
  leaseToken: string;
};
export type LiveBroadcastRecord = {
  id: string;
  videoId: string;
  title: string;
  status: LiveCurationBroadcast["status"];
  state: LiveCaptureState;
};
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const monitor = (r: QueryResultRow): LiveCurationMonitor => ({
  ...r.settings,
  id: r.id,
  revision: r.revision,
  enabled: r.enabled,
  checkedAt: iso(r.checked_at),
  error: r.error,
});
const broadcast = (r: QueryResultRow): LiveBroadcastRecord => ({
  id: r.id,
  videoId: r.video_id,
  title: r.title,
  status: r.status,
  state: r.state,
});
export function createLiveCurationRepository(pool: Pool, authorize: StudioRoleAuthority) {
  async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function fresh(userId: string, isTest: boolean) {
    if (!(await authorize({ userId, isTest, capability: "content.create" })))
      throw Error("REQUESTER_ROLE_REVOKED");
  }
  async function checked(c: PoolClient, claim: LiveMonitorClaim) {
    const row = (
      await c.query(
        "SELECT * FROM distribution.live_monitor WHERE id=$1 AND is_test=$2 AND revision=$3 AND enabled=true AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE",
        [claim.id, claim.isTest, claim.revision, claim.leaseToken],
      )
    ).rows[0];
    if (!row) throw Error("LIVE_LEASE_LOST");
    await fresh(row.requested_by, claim.isTest);
    validateLiveCurationSettings(row.settings, Date.now());
    return row;
  }
  async function current(c: PoolClient, claim: LiveMonitorClaim, id: string) {
    await checked(c, claim);
    const row = (
      await c.query(
        "SELECT * FROM distribution.live_broadcast WHERE id=$1 AND is_test=$2 AND monitor_id=$3 FOR UPDATE",
        [id, claim.isTest, claim.id],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    return row;
  }
  return {
    ready: async (isTest: boolean) =>
      Boolean(
        (
          await pool.query(
            "SELECT 1 FROM distribution.module_state WHERE id=$1 AND updated_at>clock_timestamp()-interval '90 seconds'",
            [`live-curation-worker:${isTest}`],
          )
        ).rowCount,
      ),
    heartbeat: async (isTest: boolean) => {
      await pool.query(
        "INSERT INTO distribution.module_state(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=clock_timestamp()",
        [`live-curation-worker:${isTest}`],
      );
    },
    list: async (ctx: DistributionContext) =>
      tx(async (c) => {
        await requireDistributionCapability(c, ctx, [
          "content.create",
          "content.review",
          "operations.manage",
        ]);
        const monitors = (
          await c.query(
            "SELECT * FROM distribution.live_monitor WHERE is_test=$1 ORDER BY created_at",
            [distributionWorld(ctx)],
          )
        ).rows.map(monitor);
        const rows = (
          await c.query(
            "SELECT b.*,m.channel_id FROM distribution.live_broadcast b JOIN distribution.live_monitor m ON m.id=b.monitor_id AND m.is_test=b.is_test WHERE b.is_test=$1 ORDER BY b.created_at DESC LIMIT 100",
            [ctx.isTest],
          )
        ).rows;
        const broadcasts: LiveCurationBroadcast[] = [];
        for (const row of rows) {
          const windows = (
            await c.query(
              "SELECT id,number,start_ms,end_ms,owned_end_ms,master_id,package_id FROM distribution.live_window WHERE broadcast_id=$1 AND is_test=$2 ORDER BY number",
              [row.id, ctx.isTest],
            )
          ).rows.map((w) => ({
            id: w.id,
            number: w.number,
            startMs: w.start_ms,
            endMs: w.end_ms,
            ownedEndMs: w.owned_end_ms,
            masterId: w.master_id,
            packageId: w.package_id,
          }));
          broadcasts.push({
            id: row.id,
            channelId: row.channel_id,
            videoId: row.video_id,
            title: row.title,
            status: row.status,
            error: row.error,
            capturedMs: row.state.capturedMs,
            capturedFrom: row.state.capturedFrom,
            windows,
          });
        }
        return { monitors, broadcasts };
      }),
    configure: async (
      ctx: DistributionContext,
      input: { settings: LiveCurationSettings; expectedRevision: number | null },
      channels: readonly { channelId: string; enabled: boolean; name: string }[],
    ) =>
      tx(async (c) => {
        await requireDistributionCapability(c, ctx, ["content.create"]);
        await fresh(ctx.userId, ctx.isTest);
        const channel = channels.find((v) => v.channelId === input.settings.channelId);
        if (input.settings.enabled && (!channel || !channel.enabled))
          throw Error("LIVE_CHANNEL_DISABLED");
        const settings = {
          ...input.settings,
          channelName: channel?.name ?? input.settings.channelName,
        };
        validateLiveCurationSettings(settings, Date.now());
        await c.query("SELECT pg_advisory_xact_lock(49140,$1)", [ctx.isTest ? 1 : 0]);
        const prior = (
          await c.query(
            "SELECT * FROM distribution.live_monitor WHERE channel_id=$1 AND is_test=$2 FOR UPDATE",
            [settings.channelId, distributionWorld(ctx)],
          )
        ).rows[0];
        if ((prior?.revision ?? null) !== input.expectedRevision) throw Error("REVISION_CONFLICT");
        if (settings.enabled) {
          const count = await c.query(
            "SELECT count(*)::int n FROM distribution.live_monitor WHERE is_test=$1 AND enabled AND channel_id<>$2",
            [ctx.isTest, settings.channelId],
          );
          if (count.rows[0].n >= 2) throw Error("LIVE_MONITOR_LIMIT");
        }
        const result = prior
          ? await c.query(
              "UPDATE distribution.live_monitor SET settings=$3,enabled=$4,requested_by=$5,revision=revision+1,error=NULL,available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *",
              [prior.id, ctx.isTest, settings, settings.enabled, ctx.userId],
            )
          : await c.query(
              "INSERT INTO distribution.live_monitor(is_test,channel_id,settings,enabled,requested_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [ctx.isTest, settings.channelId, settings, settings.enabled, ctx.userId],
            );
        return monitor(result.rows[0]);
      }),
    claim: async (isTest: boolean) =>
      tx(async (c) => {
        const row = (
          await c.query(
            "SELECT * FROM distribution.live_monitor WHERE is_test=$1 AND enabled AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
            [isTest],
          )
        ).rows[0];
        if (!row) return null;
        const token = randomUUID();
        await c.query(
          "UPDATE distribution.live_monitor SET lease_token=$3,lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1 AND is_test=$2",
          [row.id, isTest, token],
        );
        return {
          id: row.id,
          isTest,
          revision: row.revision,
          requestedBy: row.requested_by,
          settings: row.settings,
          leaseToken: token,
        } as LiveMonitorClaim;
      }),
    renew: async (claim: LiveMonitorClaim) =>
      tx(async (c) => {
        await checked(c, claim);
        await c.query(
          "UPDATE distribution.live_monitor SET lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1 AND is_test=$2",
          [claim.id, claim.isTest],
        );
      }),
    active: async (claim: LiveMonitorClaim) =>
      tx(async (c) => {
        await checked(c, claim);
        const row = (
          await c.query(
            "SELECT * FROM distribution.live_broadcast WHERE monitor_id=$1 AND is_test=$2 AND status='CAPTURING' ORDER BY created_at DESC LIMIT 1",
            [claim.id, claim.isTest],
          )
        ).rows[0];
        return row ? broadcast(row) : null;
      }),
    begin: async (
      claim: LiveMonitorClaim,
      video: { id: string; title: string; capturedFrom: string | null },
    ) =>
      tx(async (c) => {
        await checked(c, claim);
        if (
          !/^[A-Za-z0-9_-]{11}$/.test(video.id) ||
          !video.title.trim() ||
          video.title.length > 500
        )
          throw Error("INVALID_LIVE_CURATION");
        const state: LiveCaptureState = {
          nextSequence: null,
          buffers: [],
          offsetMs: 0,
          capturedMs: 0,
          windowNumber: 0,
          capturedFrom: video.capturedFrom,
        };
        const row =
          (
            await c.query(
              "INSERT INTO distribution.live_broadcast(is_test,monitor_id,video_id,title,state) VALUES($1,$2,$3,$4,$5) ON CONFLICT(video_id,is_test) DO NOTHING RETURNING *",
              [claim.isTest, claim.id, video.id, video.title, state],
            )
          ).rows[0] ??
          (
            await c.query(
              "SELECT * FROM distribution.live_broadcast WHERE video_id=$1 AND is_test=$2 AND monitor_id=$3",
              [video.id, claim.isTest, claim.id],
            )
          ).rows[0];
        if (!row) throw Error("LIVE_BROADCAST_CONFLICT");
        return broadcast(row);
      }),
    append: async (
      claim: LiveMonitorClaim,
      id: string,
      fragments: LiveFragment[],
      capturedFrom: string | null,
    ) =>
      tx(async (c) => {
        const row = await current(c, claim, id);
        if (row.status !== "CAPTURING") throw Error("LIVE_CAPTURE_PAUSED");
        const state = row.state as LiveCaptureState;
        if (!fragments.length || fragments.length > 300) throw Error("INVALID_LIVE_FRAGMENTS");
        let next = state.nextSequence;
        for (const f of fragments) {
          if (
            !Number.isSafeInteger(f.sequence) ||
            f.sequence < 0 ||
            !Number.isSafeInteger(f.durationMs) ||
            f.durationMs < 1 ||
            f.durationMs > 30000 ||
            !/^[a-f0-9]{64}$/.test(f.sha256) ||
            !Number.isSafeInteger(f.byteSize) ||
            f.byteSize < 1 ||
            f.byteSize > 32 * 1024 * 1024 ||
            f.key !== `distribution/live/${id}/${f.sequence}.ts` ||
            (next !== null && next !== f.sequence)
          )
            throw Error("LIVE_CAPTURE_GAP");
          next = f.sequence + 1;
        }
        if (state.buffers.length + fragments.length > 700) throw Error("LIVE_BUFFER_FULL");
        const updated: LiveCaptureState = {
          ...state,
          nextSequence: next,
          buffers: [...state.buffers, ...fragments],
          capturedMs: state.capturedMs + fragments.reduce((n, f) => n + f.durationMs, 0),
          capturedFrom: state.capturedFrom ?? capturedFrom,
        };
        await c.query(
          "UPDATE distribution.live_broadcast SET state=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
          [id, claim.isTest, updated],
        );
        return { ...broadcast(row), state: updated };
      }),
    saveWindow: async (
      claim: LiveMonitorClaim,
      id: string,
      input: { asset: PrivateAsset; ended: boolean; expectedNumber: number },
    ) =>
      tx(async (c) => {
        const row = await current(c, claim, id);
        const state = row.state as LiveCaptureState;
        if (row.status !== "CAPTURING" || state.windowNumber !== input.expectedNumber)
          throw Error("LIVE_LEASE_LOST");
        const window = liveCurationWindow(state.buffers, input.ended);
        if (!window) throw Error("LIVE_WINDOW_NOT_READY");
        const ctx = {
          userId: claim.requestedBy,
          isTest: claim.isTest,
          roles: ["CONTENT_COORDINATOR"],
        };
        const masterId = await insertContentMaster(c, ctx, {
          title: `${row.title.slice(0, 150)} · Live section ${state.windowNumber + 1}`,
          language: claim.settings.language,
          category: "pravachanams",
          asset: input.asset,
        });
        const { master } = await loadStudioSource(c, claim.isTest, masterId);
        await recordContentRights(c, ctx, master, claim.settings.rights);
        const windowId = randomUUID();
        await c.query(
          "INSERT INTO distribution.live_window(id,is_test,broadcast_id,number,start_ms,end_ms,owned_end_ms,master_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            windowId,
            claim.isTest,
            id,
            state.windowNumber + 1,
            state.offsetMs,
            state.offsetMs + window.durationMs,
            window.ownedEndMs,
            masterId,
          ],
        );
        const consumed = state.buffers.slice(0, window.nextIndex);
        const updated: LiveCaptureState = {
          ...state,
          buffers: state.buffers.slice(window.nextIndex),
          offsetMs: state.offsetMs + consumed.reduce((n, f) => n + f.durationMs, 0),
          windowNumber: state.windowNumber + 1,
        };
        await c.query(
          "UPDATE distribution.live_broadcast SET state=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
          [id, claim.isTest, updated],
        );
        return { broadcast: { ...broadcast(row), state: updated }, consumed, windowId };
      }),
    end: async (claim: LiveMonitorClaim, id: string) =>
      tx(async (c) => {
        const row = await current(c, claim, id);
        if (row.state.buffers.length) throw Error("LIVE_BUFFER_NOT_FLUSHED");
        await c.query(
          "UPDATE distribution.live_broadcast SET status='ENDED',updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
          [id, claim.isTest],
        );
      }),
    release: async (claim: LiveMonitorClaim, error: string | null = null, broadcastId?: string) =>
      tx(async (c) => {
        // Pausing or changing configuration invalidates the lease and must not be overwritten by a late worker.
        const safe = error
          ? Object.hasOwn(LIVE_CURATION_ERRORS, error)
            ? error
            : "LIVE_CAPTURE_UNAVAILABLE"
          : null;
        const changed = await c.query(
          "UPDATE distribution.live_monitor SET error=$5,checked_at=clock_timestamp(),available_at=clock_timestamp()+($6::int*interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND revision=$3 AND lease_token=$4 RETURNING id",
          [
            claim.id,
            claim.isTest,
            claim.revision,
            claim.leaseToken,
            safe,
            error && !["LIVE_CAPTURE_UNAVAILABLE", "OPERATOR_AUTHORITY_UNAVAILABLE"].includes(error)
              ? 120
              : 5,
          ],
        );
        if (
          changed.rows.length &&
          broadcastId &&
          safe &&
          ["LIVE_CAPTURE_GAP", "LIVE_STREAM_UNSUPPORTED"].includes(safe)
        )
          await c.query(
            "UPDATE distribution.live_broadcast SET status='NEEDS_ATTENTION',error=$4,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND monitor_id=$3 AND status='CAPTURING'",
            [broadcastId, claim.isTest, claim.id, safe],
          );
      }),
  };
}
