import { expect, it } from "vitest";
import type { OnlineImport } from "./online-video";
import { studioBundleWorkflow } from "./studio-progress";
const bundle = (statuses: string[]): OnlineImport => ({
  id: "bundle",
  source: {
    provider: "youtube",
    kind: "bundle",
    id: "series",
    url: "https://youtube.com/watch?v=E0000000000",
  },
  title: "Series",
  childIds: statuses.map((_, i) => String(i)),
  parentId: null,
  masterId: null,
  status: "COMPLETE",
  error: null,
  createdAt: "",
  updatedAt: "",
  curation: {
    requestedBy: "curator",
    confirmedAt: "",
    rights: {
      owner: "Owner",
      authorizationBasis: "Authorized",
      privacyClass: "PUBLIC",
      territories: ["WORLDWIDE"],
      channels: ["youtube"],
      releaseAt: null,
      expiresAt: null,
    },
    request: { channels: ["youtube"], languages: ["en"], captions: true, instructions: "" },
    items: Object.fromEntries(statuses.map((status, i) => [String(i), { status }])),
  },
});
it("lets a curator review ready recordings while generation is still running", () => {
  const flow = studioBundleWorkflow(bundle(["DRAFT", "GENERATING", "QUEUED"]));
  expect(flow.current).toBe(3);
  expect(flow.steps[1]?.label).toBe("1 of 3 recordings ready");
  expect(flow.steps[1]?.state).not.toBe("done");
});
it("never treats approval as publication", () => {
  const flow = studioBundleWorkflow(bundle(["APPROVED", "APPROVED"]));
  expect(flow.current).toBe(6);
  expect(flow.steps[5]?.state).toBe("current");
  expect(flow.steps[5]?.label).toBe("You are here");
});
it("retains file availability while a card update is queued without implying it can be submitted", () => {
  const item = bundle(["GENERATING", "QUEUED"]);
  if (!item.curation) throw Error("missing fixture");
  item.curation.items["0"] = { status: "GENERATING", outputCount: 2 };
  item.curation.items["1"] = { status: "QUEUED", outputCount: 3 };
  const flow = studioBundleWorkflow(item);
  expect(flow.current).toBe(2);
  expect(flow.steps[1]?.label).toBe("2 of 2 recordings have files · updates in progress");
  expect(flow.steps[2]?.state).toBe("pending");
});
it("prioritizes returned files without losing siblings' progress", () => {
  const flow = studioBundleWorkflow(bundle(["APPROVED", "CHANGES_REQUESTED", "GENERATING"]));
  expect(flow.current).toBe(5);
  expect(flow.steps[4]?.label).toBe("1 returned for changes");
  expect(flow.steps[3]?.label).toBe("1 of 3 approved");
});
