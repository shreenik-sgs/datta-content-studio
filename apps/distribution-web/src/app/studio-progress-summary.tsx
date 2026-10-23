"use client";
import {
  studioFileWorkflowStep,
  studioNeedsSuitabilityReview,
  studioWorkflow,
} from "@satsang/distribution-domain";
import type { PublicStudioPackage, PublicStudioPublication } from "../lib/studio-model";
import "./studio-workflow.css";

export function packageWorkflowStep(value: PublicStudioPackage) {
  return studioWorkflow({ package: value }).current;
}

/** A series can occupy several stages. Counts describe saved facts, never authorize an action. */
export function StudioProgressSummary({
  packages,
  publications = [],
  totalRecordings,
  selectedStep,
  onStep,
  preview = false,
}: {
  packages: readonly PublicStudioPackage[];
  publications?: readonly PublicStudioPublication[];
  totalRecordings?: number | undefined;
  selectedStep?: number | null;
  onStep?: (step: number | null) => void;
  preview?: boolean;
}) {
  const active = packages.filter(
    (p) =>
      p.status !== "DISCARDED" &&
      !(
        !p.outputs.length &&
        (studioNeedsSuitabilityReview(p.failure) ||
          (p.status === "DRAFT" && p.provenance?.skippedChannels.length))
      ),
  );
  const flows = active.flatMap((p) =>
    (p.outputs.length
      ? p.outputs
          .filter((o) => o.included)
          .map((o) => ({
            ...p,
            status: o.workflow?.status ?? p.status,
            approval: o.workflow?.approval ?? p.approval,
            outputs: [o],
          }))
      : [p]
    ).map((pkg) => ({
      pkg,
      flow: studioWorkflow({
        package: pkg,
        publications: publications.filter((j) => j.packageId === p.id),
      }),
      current: pkg.outputs[0]?.workflow ? studioFileWorkflowStep(pkg, pkg.outputs[0]) : undefined,
    })),
  );

  const steps = studioWorkflow({ starting: true }).steps;
  const pending = Math.max(0, (totalRecordings ?? packages.length) - packages.length);
  const shortTitles = [
    "Source & rights",
    "Generate",
    "Check & submit",
    "Review & approve",
    "Revise if needed",
    "Post & track",
  ];
  return (
    <section
      className="studio-workflow workflow-summary"
      aria-label={preview ? "File workflow" : "Series workflow"}
    >
      <div className="studio-workflow-heading">
        <h3>{preview ? "File progress" : "Series progress"}</h3>
        {onStep && selectedStep && (
          <button
            type="button"
            className="button"
            onClick={() => onStep(null)}
            disabled={!selectedStep}
          >
            Show all files
          </button>
        )}
      </div>
      <ol>
        {steps.map((step) => {
          const atStep = flows.filter(
            ({ flow, current }) =>
              (current ?? flow.current ?? (flow.complete ? 6 : null)) === step.number,
          );
          const count = atStep.reduce(
            (n, { pkg }) => n + pkg.outputs.filter((o) => o.included).length,
            0,
          );
          const done =
            !pending &&
            flows.length > 0 &&
            flows.every(({ flow }) => flow.steps[step.number - 1]?.state === "done");
          const state = done
            ? "done"
            : atStep.length
              ? "current"
              : step.number === 5
                ? "optional"
                : "pending";
          const label =
            done && step.number === 6
              ? active.every((p) => p.isTest)
                ? "Test complete"
                : "Posted"
              : count
                ? `${count} ${count === 1 ? "file" : "files"}`
                : atStep.length
                  ? `${atStep.length} recordings`
                  : step.number === 2 && pending
                    ? `${pending} waiting`
                    : done
                      ? "Done"
                      : step.number === 5
                        ? "Only if requested"
                        : "—";
          const copy = (
            <>
              <span className="workflow-number" aria-hidden="true">
                {done ? "✓" : step.number}
              </span>
              <span className="workflow-step-copy">
                <strong>{shortTitles[step.number - 1]}</strong>
                <span className="workflow-state">{label}</span>
              </span>
            </>
          );
          return (
            <li
              key={step.number}
              className={`workflow-${state}`}
              aria-current={preview && state === "current" ? "step" : undefined}
            >
              {onStep ? (
                <button
                  type="button"
                  disabled={!atStep.length}
                  aria-pressed={selectedStep === step.number}
                  onClick={() => onStep(selectedStep === step.number ? null : step.number)}
                >
                  {copy}
                </button>
              ) : (
                <div className="workflow-readonly">{copy}</div>
              )}
            </li>
          );
        })}
      </ol>
      {!preview && (
        <p className="workflow-explanation">
          Select a stage to filter files. Each file progresses independently; approval does not mean
          it has been posted.
        </p>
      )}
    </section>
  );
}
