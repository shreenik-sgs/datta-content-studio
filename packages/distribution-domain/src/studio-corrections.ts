import type { StudioOutput, StudioPackage } from "./intelligent-content";

/** A correction always has an explicit file scope; missing scope never means every file. */
export function studioCorrectionTargets(
  pkg: Pick<StudioPackage, "outputs">,
  requested?: string[],
): string[] {
  const ids =
    requested ??
    pkg.outputs
      .filter((o) => o.included && (o.correction?.state === "pending" || !o.asset))
      .map((o) => o.id);
  if (
    (pkg.outputs.length || ids.length) &&
    (!ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !pkg.outputs.some((o) => o.id === id && o.included)))
  )
    throw new Error("STUDIO_SELECT_OUTPUTS");
  return [...ids];
}

/** Structural equality ignores JSON object key order while preserving array order and values. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
  );
}

/** The persistence boundary refuses worker results which alter or drop an unselected file. */
export function assertStudioCorrectionIsolation(
  before: readonly StudioOutput[],
  after: readonly StudioOutput[],
  outputIds: readonly string[],
) {
  const targets = new Set(outputIds);
  if (
    after.length !== before.length ||
    before.some((old) => {
      const updated = after.find((o) => o.id === old.id);
      return (
        !updated ||
        (!targets.has(old.id) && !same(old, updated)) ||
        (targets.has(old.id) &&
          (updated.channel !== old.channel ||
            updated.language !== old.language ||
            updated.format !== old.format ||
            updated.included !== old.included))
      );
    })
  )
    throw new Error("STUDIO_UNRELATED_OUTPUT_CHANGED");
}
