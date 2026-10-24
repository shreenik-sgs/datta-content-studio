import {
  type StudioPackage,
  type StudioPublication,
  studioNeedsSuitabilityReview,
} from "./intelligent-content";
import type { OnlineImport } from "./online-video";
import { type StudioFileWorkflow, studioPublicationMatchesFile } from "./studio-file-workflow";

export type StudioWorkflowState = "done" | "current" | "pending" | "optional" | "stopped";
export type StudioWorkflowStep = {
  number: number;
  title: string;
  owner: string;
  state: StudioWorkflowState;
  label: string;
};

/** Collection progress derives from every member; approval never implies publication. */
export function studioBundleWorkflow(item: OnlineImport) {
  const total = item.childIds?.length ?? 0;
  const statuses = (item.childIds ?? []).map((id) => item.curation?.items[id]?.status);
  const count = (...values: string[]) =>
    statuses.filter((status) => values.includes(status ?? "")).length;
  const generated = (item.childIds ?? []).filter((id) => {
    const member = item.curation?.items[id];
    return member?.outputCount !== undefined
      ? member.outputCount > 0
      : ["DRAFT", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "DISCARDED"].includes(
          member?.status ?? "",
        );
  }).length;
  const refreshing = Object.values(item.curation?.items ?? {}).some(
    (m) => (m.outputCount ?? 0) > 0 && ["QUEUED", "GENERATING"].includes(m.status ?? ""),
  );
  const submitted = count("IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "DISCARDED");
  const approved = count("APPROVED");
  const returned = count("CHANGES_REQUESTED");
  const current = !item.curation
    ? 1
    : item.curation.pausedForSettings
      ? 2
      : returned
        ? 5
        : count("DRAFT")
          ? 3
          : count("IN_REVIEW")
            ? 4
            : approved + count("DISCARDED") === total && approved > 0
              ? 6
              : 2;
  const steps = studioWorkflow({ starting: true }).steps;
  for (const step of steps) {
    step.state = "pending";
    step.label = "Pending";
    if (step.number === 1 && item.curation) {
      step.state = "done";
      step.label = "Shared settings saved";
    }
    if (step.number === 2 && item.curation) {
      step.state = total > 0 && generated === total ? "done" : "pending";
      step.label = refreshing
        ? `${generated} of ${total} recordings have files · updates in progress`
        : `${generated} of ${total} recordings ready`;
      if (item.curation.pausedForSettings) {
        step.owner = "Content Curator";
        step.label = "Paused — choose channels and resume";
      }
    }
    if (step.number === 3 && submitted) {
      step.state = submitted === total ? "done" : "pending";
      step.label = `${submitted} of ${total} submitted or resolved`;
    }
    if (step.number === 4 && approved) {
      step.state = approved === total ? "done" : "pending";
      step.label = `${approved} of ${total} approved`;
    }
    if (step.number === 5) {
      step.state = "optional";
      step.label = returned ? `${returned} returned for changes` : "Only if requested";
    }
    if (step.number === current) {
      step.state = "current";
      if (step.label === "Pending") step.label = "You are here";
    }
  }
  return { steps, current };
}
/** Presentation of persisted workflow facts; never grants approval or publication authority. */
export function studioWorkflow(input: {
  package?: Pick<StudioPackage, "status" | "revision" | "isTest" | "feedback"> & {
    failure?: string | null;
    outputs: readonly { id: string; included: boolean; workflow?: StudioFileWorkflow }[];
  };
  hasMaster?: boolean;
  starting?: boolean;
  combinedRoles?: boolean;
  permissionsReady?: boolean;
  publications?: readonly Pick<StudioPublication, "outputId" | "packageRevision" | "status">[];
}) {
  const pkg = input.package;
  const status = pkg?.status;
  const returned = pkg?.feedback.some((entry) => entry.action === "REJECTED") ?? false;
  const included = pkg?.outputs.filter((output) => output.included) ?? [];
  const publications = (input.publications ?? []).filter(
    (p) =>
      pkg && included.some((o) => o.id === p.outputId && studioPublicationMatchesFile(pkg, o, p)),
  );
  const complete =
    status === "APPROVED" &&
    included.length > 0 &&
    included.every((output) =>
      publications.some(
        (p) =>
          p.outputId === output.id &&
          (p.status === "PUBLISHED" || (pkg?.isTest && p.status === "SIMULATED")),
      ),
    );
  const stopped = status === "DISCARDED";
  const current =
    stopped || complete
      ? null
      : !pkg
        ? input.hasMaster
          ? input.permissionsReady === false
            ? 1
            : 2
          : input.starting
            ? 1
            : null
        : ["QUEUED", "GENERATING", "FAILED"].includes(pkg.status)
          ? returned && pkg.outputs.length
            ? 5
            : 2
          : status === "CHANGES_REQUESTED" || (status === "DRAFT" && returned)
            ? 5
            : status === "DRAFT"
              ? 3
              : status === "IN_REVIEW"
                ? 4
                : 6;
  const steps: StudioWorkflowStep[] = [
    {
      number: 1,
      title: "Choose master & permissions",
      owner: "Content Curator",
      state: (input.hasMaster && input.permissionsReady !== false) || pkg ? "done" : "pending",
      label: input.hasMaster || pkg ? "Master selected" : "Pending",
    },
    {
      number: 2,
      title: "Generate channel drafts",
      owner: "System",
      state:
        pkg &&
        (returned || !["QUEUED", "GENERATING", "FAILED"].includes(pkg.status)) &&
        pkg.outputs.length
          ? "done"
          : "pending",
      label: "Pending",
    },
    {
      number: 3,
      title: "Check & submit",
      owner: "Content Curator",
      state:
        ["IN_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(status ?? "") || returned
          ? "done"
          : "pending",
      label: "Pending",
    },
    {
      number: 4,
      title: "Review & approve",
      owner: "Content Approver",
      state: status === "APPROVED" ? "done" : "pending",
      label:
        status === "CHANGES_REQUESTED" || (returned && current !== 4 && status !== "APPROVED")
          ? "Changes requested"
          : "Pending",
    },
    {
      number: 5,
      title: "Revise if requested",
      owner: "Content Curator → Approver",
      state: returned ? (status === "APPROVED" ? "done" : "pending") : "optional",
      label: returned ? "Pending" : "Only if needed",
    },
    {
      number: 6,
      title: "Publish approved channels",
      owner: "Content Approver → System",
      state: complete ? "done" : "pending",
      label: complete ? (pkg?.isTest ? "Test completed" : "Published") : "Pending",
    },
  ];
  for (const step of steps) {
    if (stopped) {
      step.state = "stopped";
      step.label = "Stopped";
    } else if (step.number === current) {
      step.state = "current";
      step.label = "You are here";
    } else if (step.state === "done" && step.number !== 1 && step.number !== 6) step.label = "Done";
  }
  const deliveryIssue = publications.some((p) =>
    ["BLOCKED", "FAILED", "UNCERTAIN", "CANCELLED"].includes(p.status),
  );
  const message = stopped
    ? "This package was discarded. Nothing further will be published from it."
    : complete
      ? pkg?.isTest
        ? "Publication test completed. Nothing was posted to social channels."
        : "All included outputs have been published."
      : current === 1
        ? input.hasMaster
          ? "Confirm how the Ashrama permits this master to be used before generating channel drafts."
          : "Import a video or playlist, or upload a recording. Then confirm its permissions before generating channel drafts."
        : current === 2
          ? status === "FAILED"
            ? studioNeedsSuitabilityReview(pkg?.failure)
              ? "No suitable excerpt was found. Review the source and guidance before generating again; the other recordings can continue."
              : "Generation needs attention. Check the error and retry when ready."
            : status === "GENERATING"
              ? "The system is generating drafts. Human review comes afterwards."
              : "Generate suitable channel drafts from the selected master."
          : current === 3
            ? input.combinedRoles
              ? "Check the generated files, then continue to your separate approval review."
              : "Check the generated files, then send them to the Content Approver."
            : current === 4
              ? input.combinedRoles
                ? "Review the master permissions and included files, then approve or request changes."
                : "Waiting for the Content Approver to review the master and the included files."
              : current === 5
                ? status === "QUEUED" || status === "GENERATING"
                  ? "Generating corrections for selected files. Other files remain unchanged."
                  : status === "FAILED"
                    ? "File correction needs attention. Check the error and retry the selected file."
                    : input.combinedRoles
                      ? "Correct the selected files, then return to the approval review. Other files remain unchanged."
                      : "Apply the review comments and resubmit. The Content Approver must review the corrected content again."
                : current === 6
                  ? deliveryIssue
                    ? "Some channels need attention. Check their results before retrying."
                    : "Approved. Publish the included files and check each channel’s result."
                  : "Choose a master to start, or open an existing package to see its progress.";
  return { steps, current, complete, stopped, message };
}
