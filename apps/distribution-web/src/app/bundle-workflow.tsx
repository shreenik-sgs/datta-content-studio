import { type OnlineImport, studioBundleWorkflow } from "@satsang/distribution-domain";
import "./studio-workflow.css";

export function BundleWorkflow({ item }: { item: OnlineImport }) {
  const flow = studioBundleWorkflow(item);
  return (
    <section className="studio-workflow" aria-label="Series workflow">
      <div className="studio-workflow-heading">
        <h3>Curation workflow</h3>
        <span>Step {flow.current} of 6</span>
      </div>
      <p>
        {item.curation?.pausedForSettings
          ? "Your recordings and saved work are preserved. Generation resumes only after you save your channel choices."
          : "Each recording keeps its own progress. You can review ready files while the remaining recordings continue."}
      </p>
      <ol>
        {flow.steps.map((step) => (
          <li
            key={step.number}
            className={`workflow-${step.state} workflow-readonly`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="workflow-number" aria-hidden="true">
              {step.state === "done" ? "✓" : step.number}
            </span>
            <span className="workflow-step-copy">
              <strong>{step.title}</strong>
              <small>{step.owner}</small>
              <span className="workflow-state">{step.label}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
