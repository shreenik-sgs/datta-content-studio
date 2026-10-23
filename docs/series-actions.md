# Series submission, approval, posting and retraction

Open a playlist's bundle in Continue Existing Curation. Series actions offers
All and Selected buttons for the roles the signed-in operator currently holds.
Opening a selection only reads current state; it does not change any content.

- Curator: Submit All / Selected sends each chosen recording's included files
  for review. Unfinished corrections and missing assets remain blocked.
- Approver: Approve All / Selected operates only on submitted recordings.
  Review acknowledgement covers the native transcript, translations, subtitles,
  and completeness of the teaching. Unapproved source permissions are displayed
  and require a separate acknowledgement. It never submits Curator drafts or posts
  automatically. The existing independent-review and native-reviewer rules apply.
- Approver with publishing permission: Post All / Selected selects individual
  approved files and an explicit account per destination. It queues only those
  files. The worker checks current authority, immutable approval, source rights
  and destination-specific duplicate history immediately before sending.
- Retract All / Selected selects individual posting records, including older
  published revisions. Unsent local queued/blocked jobs are cancelled atomically
  with an audit record. Active/uncertain sends retain their leases and receipts.
  TEST simulations can be cancelled; published local blog entries are hidden.
  External published videos remain marked Published until removal is established.
  Buffer cannot remove published videos from YouTube; the result links the post
  and YouTube Studio and explicitly requires removal on the channel. It does not
  delete the Buffer history or claim that deleting it removes the actual video.

Submission/approval selection is recording-level because approval covers an
immutable package revision. Posting/retraction selection is file-level. No source,
manual trim, caption, media asset, or existing review history is deleted.

Each selected recording is processed sequentially using the same authenticated,
revision-checked API as an individual action. One failure does not hide earlier
successes; results identify each successful/blocked item. An ambiguous network
response stops the remaining batch, without automatic retries. Refresh before
retrying; committed states and queued job identities survive reloads. Keep the
page open while processing. The batch is not an all-or-nothing transaction.
If source approval succeeds but file approval fails, the result says so explicitly.

TEST is simulation-only. Merely saving channel credentials or approving files
does not enable LIVE publication. All 95 existing local Vishnu Purana drafts are
left untouched by installation or verification of this feature.
