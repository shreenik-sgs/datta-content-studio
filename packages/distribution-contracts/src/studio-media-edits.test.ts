import { STUDIO_MEDIA_DEFAULTS } from "@satsang/distribution-domain";
import { expect, it } from "vitest";
import { studioReviseSchema } from "./intelligent-content";

const edit = {
  expectedRevision: 3,
  render: true,
  comment: "Correct the selected file",
  outputs: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Complete teaching",
      body: "Act kindly. @sgsswamiji",
      included: true,
      mediaEdits: STUDIO_MEDIA_DEFAULTS,
    },
  ],
};
it("accepts one atomic manual correction and retains older text-only requests", () => {
  expect(studioReviseSchema.parse(edit)).toEqual(edit);
  expect(
    studioReviseSchema.safeParse({
      expectedRevision: 3,
      comment: "",
      outputs: [{ id: edit.outputs[0]?.id, title: "Title", body: "Text", included: true }],
    }).success,
  ).toBe(true);
});
it.each([
  { portraitFocus: Number.POSITIVE_INFINITY },
  { portraitFocus: -1 },
  { speechLevel: "raw gain" },
  { reduceNoise: "yes" },
  { filter: "unsafe" },
])("rejects invalid persisted media settings %j", (override) => {
  expect(
    studioReviseSchema.safeParse({
      ...edit,
      outputs: [{ ...edit.outputs[0], mediaEdits: { ...STUDIO_MEDIA_DEFAULTS, ...override } }],
    }).success,
  ).toBe(false);
});

it.each([
  { startMs: -2, endMs: 4000 },
  { startMs: 4000, endMs: 2000 },
  { startMs: 0, endMs: 500 },
  { startMs: 0, endMs: 4000, filter: "unsafe" },
])("rejects invalid trim requests %j", (sourceTrim) => {
  expect(
    studioReviseSchema.safeParse({ ...edit, outputs: [{ ...edit.outputs[0], sourceTrim }] })
      .success,
  ).toBe(false);
});
it("accepts millisecond trim boundaries and an explicit reset", () => {
  for (const sourceTrim of [{ startMs: 2010, endMs: 4090 }, null])
    expect(
      studioReviseSchema.safeParse({ ...edit, outputs: [{ ...edit.outputs[0], sourceTrim }] })
        .success,
    ).toBe(true);
});
