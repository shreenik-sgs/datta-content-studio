import type { StudioPackage } from "./intelligent-content";
import { validateStudioDiscoveryCoverage } from "./studio-discovery";

/** Stored with the bundle, not in a browser session or an operator's filesystem. */
export type StudioSeriesWorkflow = {
  id: string;
  version: number;
  state: "running" | "paused" | "blocked" | "complete";
  phase: "shorts" | "stories" | "closings" | "complete";
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  sourceIds: string[];
  error?: string;
  members: Record<
    string,
    {
      /** Immutable revision references are the preservation baseline. */
      baselineRevision: number;
      storyRevision?: number;
      closingRevision?: number;
      completedRevision?: number;
      shorts?: number;
      stories?: number;
      noSuitableStory?: boolean;
      exclusions?: string[];
    }
  >;
  history: { at: string; action: string; actorId: string }[];
};

export function requireSeriesDraft(pkg: StudioPackage): void {
  if (
    pkg.status !== "DRAFT" ||
    pkg.approval ||
    !pkg.outputs.length ||
    pkg.outputs.some((o) => o.included && o.workflow && o.workflow.status !== "DRAFT")
  )
    throw Error("STUDIO_SERIES_DRAFT_REQUIRED");
}

export function requireSeriesStoryRequest(pkg: StudioPackage): void {
  // Story discovery currently supports YouTube video exports. Never silently
  // change the other channels of an existing multi-channel curation.
  if (
    pkg.request.channels.length !== 1 ||
    pkg.request.channels[0] !== "youtube" ||
    !pkg.request.allCompleteMessages ||
    !pkg.request.captions ||
    !pkg.provenance
  )
    throw Error("STUDIO_SERIES_STORY_SETTINGS_REQUIRED");
}

export function seriesStoryCoverage(pkg: StudioPackage) {
  const discovery = pkg.provenance?.discovery;
  if (!discovery || discovery.policy !== "story-discovery-v1" || !pkg.provenance) return false;
  validateStudioDiscoveryCoverage(discovery, pkg.provenance.transcript);
  return true;
}

export const STUDIO_SERIES_WORKFLOW_MESSAGES: Record<string, string> = {
  STUDIO_SERIES_DRAFT_REQUIRED:
    "Every recording must finish as an unapproved draft with files before the next stage. Review the recording that needs attention.",
  STUDIO_SERIES_STORY_SETTINGS_REQUIRED:
    "Complete-story discovery requires a YouTube-only series with subtitles, complete-message discovery, and saved transcripts. Existing channel settings are preserved.",
  STUDIO_SERIES_MEMBERS_CHANGED:
    "The recordings in this series changed. Review the series before continuing; no additional jobs were started.",
  STUDIO_SERIES_CONTENT_CHANGED:
    "A recording or file changed after this workflow recorded its baseline. Your edits are retained. Review that recording before continuing.",
  STUDIO_SERIES_STORY_COVERAGE_REQUIRED:
    "A recording has not completed story discovery. Check its progress or failure details before continuing.",
  STUDIO_SERIES_MEDIA_VERIFICATION_REQUIRED:
    "A saved file has not passed the final media checks. The existing file is retained; check the recording's error details.",
  STUDIO_SERIES_WORKFLOW_CHANGED:
    "This workflow changed in another session. Refresh its status before trying again.",
  STUDIO_SERIES_WORKFLOW_FAILED:
    "The series workflow needs attention. Existing files and checkpoints are retained.",
};
