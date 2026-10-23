"use client";
import { studioWorkflow } from "@satsang/distribution-domain";
import type { PublicStudioPackage, PublicStudioPublication } from "../lib/studio-model";
import "./studio-workflow.css";

export function StudioWorkflow({
  value,
  combinedRoles = false,
  reviewerOnly = false,
  hasMaster,
  starting = false,
  permissionsReady,
  publications,
  onStep,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  value: PublicStudioPackage | undefined;
  combinedRoles?: boolean;
  reviewerOnly?: boolean;
  hasMaster: boolean;
  starting?: boolean;
  permissionsReady: boolean | undefined;
  publications: readonly PublicStudioPublication[];
  onStep: (step: number) => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled: boolean;
}) {
  const flow = studioWorkflow({
    ...(value ? { package: value } : {}),
    hasMaster,
    starting,
    combinedRoles,
    ...(permissionsReady === undefined ? {} : { permissionsReady }),
    publications,
  });
  return (
    <section className="studio-workflow" aria-label="Content workflow">
      <div className="studio-workflow-heading">
        <h3>Curation workflow</h3>
        <span>
          {flow.stopped
            ? "Stopped"
            : flow.complete
              ? value?.isTest
                ? "Test complete"
                : "Complete"
              : flow.current
                ? `Step ${flow.current} of 6`
                : "Six steps"}
        </span>
      </div>
      <p aria-live="polite">
        {reviewerOnly && value?.status === "DRAFT"
          ? "Awaiting Curator submission. You can preview the drafts, but approval becomes available after the Curator submits this recording’s files for review."
          : reviewerOnly && value?.status === "IN_REVIEW"
            ? "Review the master permissions and included files, then approve or request changes."
            : flow.message}
      </p>
      <ol>
        {flow.steps.map((step) => (
          <li
            key={step.number}
            className={`workflow-${step.state}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <button
              type="button"
              onClick={() => onStep(step.number)}
              disabled={
                step.number !== 1 &&
                step.state !== "current" &&
                !(step.number === 3 && step.state === "done")
              }
            >
              <span className="workflow-number" aria-hidden="true">
                {step.state === "done" ? "✓" : step.number}
              </span>
              <span className="workflow-step-copy">
                <strong>{step.title}</strong>
                <small>{step.owner}</small>
                <span className="workflow-state">{step.label}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="workflow-navigation">
        <button
          type="button"
          className="button primary"
          disabled={nextDisabled || flow.stopped || flow.complete}
          onClick={onNext}
        >
          Next: {nextLabel} →
        </button>
      </div>
    </section>
  );
}
