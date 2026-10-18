# Storage cleanup and playlist workspaces

Available in the local Hub: open a source in Continue Existing Curation and choose **Delete master…**, **Delete package…**, or **Delete playlist…** near its workspace title. Opening Delete automatically loads a preview. The permanent-delete button stays visible and is disabled until checks pass; blocked previews prominently explain the required role or dependency. Preview reports targeted masters, packages, unique media descriptors, estimated live bytes, shared files retained and blocking operations. Confirm **Permanently delete selected files** to queue erasure. **Storage cleanup history** shows progress and retries.

- Package: erase generated media, captions, thumbnails and superseded file revisions; keep the master.
- Master or playlist: defaults to erasing the selected masters plus their packages. Choose **Generated packages only — keep masters** to retain the originals instead. Both options require a preview and explicit confirmation.
- Preserve metadata, provenance and human review/audit records. Already published social posts are not removed.
- A curator may remove their own drafts/failed/returned/queued content. An Approver must remove submitted, approved, published or another curator's content, including approved masters.
- Block active downloads, generation, publishing (including uncertain remote delivery), live capture and master deletion while campaigns/invitations reference it. Shared playlist members must be reviewed separately. Count shared physical assets only once and preserve any asset another active package/render still references.
- Confirmation is bound to a fresh plan hash, revalidated under short database locks. Tombstones prevent stale API requests and workers reviving erased records or attaching retired media to another package. The durable deletion outbox resumes after failures; existing private-storage integrity, path, symlink and world checks still apply. No arbitrary client file paths are accepted.
- Deleting only playlist outputs preserves shared settings and masters but pauses automatic downloads/generation. Explicit **Generate again from saved masters** resumes it. Reimporting a fully removed source creates a fresh workspace.
- Local disk deletion reclaims file bytes. In S3, versioned/noncurrent objects and backups remain subject to the bucket's lifecycle/retention policy; the preview estimates current referenced media, not retained S3 versions. Unreferenced legacy scratch/backup directories are not included.

## Large playlists

Continue Existing Curation uses **Choose a source to continue** with playlists as bundles followed by individual masters. Playlist children are excluded from the individual list. Selecting a playlist opens its shared setup/progress and generated files.

The overview pages source summaries (20 per page); member metadata is fetched only for the selected bundle. Member progress displays 20 recordings per page. The existing import ceiling is 100 videos per playlist. Discovery fetches metadata, not all media. A provider has one active download across worker instances. Downloads follow playlist order, permit one initial recording before shared setup, and keep at most three downloaded recordings awaiting generation after setup. The generation scheduler admits at most two pending/running jobs before adding another member. The worker processes one generation job at a time. Completed media remains stored until explicitly cleaned up; this bounds concurrent work rather than total retained storage.

## Deployment

Apply Distribution migrations through 0021 and runtime-grants.sql before restarting Hub web/workers. The grant for lock_storage_cleanup() exposes only fixed-table lock acquisition; the runtime still cannot update immutable revision/audit rows. Imports/all worker modes drain cleanup jobs. No core or practice ledger data is touched.

Validation includes isolated runtime-role PostgreSQL tests, real filesystem deletion/retry/path guards, UI confirmation/blocker checks, source-navigation regressions and signed-in local browser checks. No user media is deleted by these checks.
