import { createHash } from "node:crypto";
import {
  type StudioOutput,
  type StudioPackage,
  studioFileStatus,
} from "@satsang/distribution-domain";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
/** Approval survives sibling workflow changes, never a change to the approved file or transcript. */
export function studioFileFingerprint(pkg: StudioPackage, output: StudioOutput) {
  const { workflow: _workflow, correction: _correction, ...content } = output;
  return createHash("sha256")
    .update(canonical({ content, source: pkg.source, transcript: pkg.provenance?.transcript }))
    .digest("hex");
}
export function materializeFileWorkflows(pkg: StudioPackage): StudioOutput[] {
  return pkg.outputs.map((output) => {
    if (output.workflow) return output;
    const state = studioFileStatus(pkg, output);
    const status =
      state === "FAILED" || state === "GENERATING" || state === "QUEUED" ? "DRAFT" : state;
    const approval =
      status === "APPROVED" && pkg.approval?.revision === pkg.revision
        ? { ...pkg.approval, fingerprint: studioFileFingerprint(pkg, output) }
        : undefined;
    return {
      ...output,
      workflow: {
        status,
        actorId: pkg.approval?.reviewerId ?? pkg.createdBy,
        updatedAt: pkg.updatedAt,
        ...(approval ? { approval } : {}),
      },
    };
  });
}
