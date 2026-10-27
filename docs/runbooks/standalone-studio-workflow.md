# Standalone Datta Media Studio workflow

Studio's web service and worker own content processing. An operator uses Studio
controls; Codex, shell scripts and maintenance containers are not part of the
content workflow. Deployment, service credentials and infrastructure maintenance
remain separate administrative tasks. Provider restrictions and human approval
can still require a person; the application must explain these blocks honestly.

## Series completion

In a YouTube series with complete-message discovery and subtitles enabled, a
Curator chooses **Complete this series automatically**. Studio saves the request,
membership, actor, immutable revision baselines and progress in the application's
database. Closing the browser or restarting a worker does not lose the workflow.

1. Existing Shorts jobs finish. All sources must have unapproved draft outputs.
   The next stage waits for zero queued/running generation, publication and import
   jobs on the shared worker, including either TEST or LIVE. Queue admissions and
   this idle check share a database fence; content and actions stay in their own
   TEST or LIVE world.
2. Native discovery appends continuous complete stories over three minutes and up
   to thirty minutes, using saved source transcripts and separate
   `story-discovery-v1` checkpoints. Original Shorts remain unchanged. English
   translation, source-audio boundary and presentation reviews remain mandatory.
   A reviewed source with no suitable longer story is reported as such.
3. Closing-only jobs check actual saved media. Correct cards are not encoded again.
   A replacement copies the unchanged H.264 packets and original encoded audio,
   encodes only the ending, and checks picture/caption preservation. Actual card
   pixels are compared separately for portrait, name, full-video link and subscribe
   link. Whole-file decoding, audio stream identity and exact reviewed VTT text and
   timings are recorded with the media hash and file version.
4. Completion requires all saved evidence to match current files, original IDs,
   edits and source coverage. It never submits, approves or publishes.

The worker commits an entire stage and its accepted jobs in one transaction. A
lost response cannot duplicate the stage. Failed paid calls are not retried
automatically. **Pause after current work** stops future stages while accepted
jobs finish. Resolve a failed recording through its normal recovery controls,
then **Resume series workflow**. Changed drafts block progression. After reviewing
them, **Use current drafts and run checks** records a new preservation baseline and
archives the earlier workflow history; it does not overwrite those edits.

## Draft closing cards

Open a draft file's editing controls from the table and expand **Check closing
cards and channel links**. The Curator can correct the subscription and full-video
destinations, then choose **Check and update closing cards**. Settings and the
checked closing job commit atomically. Submitted/approved recordings are locked.
No Admin identity is added as a content contributor merely to perform a repair.

## Replacement for earlier operational interventions

| Earlier intervention | Permanent application path |
| --- | --- |
| Resume failed discovery/rendering from hand-written requests | Recording/series recovery controls reuse saved requests and checkpoints, including closing destinations and timing options. Active jobs are never restarted. |
| Media-slot wait timeouts | The worker's FIFO media limiter waits without the former five-minute queue deadline; execution deadlines, advancing-frame watchdogs and cancellation still apply. |
| Reject incomplete source boundaries | The worker excludes only independent, undelivered candidates rejected by actual boundary/presentation checks and retains negative checkpoints/reasons. Existing-file corrections and all-rejected batches fail closed. |
| Queue longer stories after Shorts | Durable series workflow above, with globally idle stage transitions and saved baselines. |
| External closing-card rewrite/watch containers | Native closing jobs and verification checkpoints; unchanged media is skipped, approved media is locked. |
| Files hidden while generation continues | The series table shows committed drafts and validated pending saved files, with status/version. Pending files cannot be selected for approval or posting. |
| Inspect posting failures through server logs | Posting preparation runs the same fresh contributor, source-rights and approval checks on the server before confirmation and displays the blocker. The send action rechecks them. |
| Direct role repair | No automatic role changes. Admin reviews roles using the app's existing role controls; publishing never bypasses revoked-authority checks. |
| Upload/download recovery CLI | Native import verification, original-file upload and the existing Studio recovery page. Provider rejection stays visible and never becomes a claimed successful import. |

The former `ops/recover-online-playlist.mts`,
`ops/refresh-preview-and-draft-closings.mts`,
`ops/refresh-youtube-bundle-destination.mts`, and
`ops/retarget-youtube-bundle.mts` now fail immediately without reading credentials
or touching content. Their historical implementations remain in Git history.

## Release and acceptance

Ship matching tested web and worker releases through normal deployment. Preserve
active jobs and activate the new worker only once its current work is idle.
Existing external monitor journals are historical evidence, not orchestration.
Code tests use synthetic media and a disposable database; they are not evidence
that the real Bhagavat series has completed. Staging acceptance must exercise the
native controls and inspect actual saved final evidence before reporting counts
or completion. Longer MP4s are downloadable for YouTube Studio; Buffer supports
Shorts only. The already verified and approved Vishnu files remain untouched.
