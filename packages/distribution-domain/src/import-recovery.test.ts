import { expect, it } from "vitest";
import { matchOriginalRecordings, verificationSignInBlocked } from "./import-recovery";
import type { OnlineImport } from "./online-video";
const item = (id: string, title: string | null = null, masterId: string | null = null) =>
  ({
    id,
    source: { kind: "video", provider: "youtube", id, url: `https://youtube.com/watch?v=${id}` },
    title,
    masterId,
  }) as OnlineImport;
it("recognizes Google's explicit browser rejection without treating challenges or wrong passwords as one", () => {
  const rejection = "Couldn’t sign you in\nThis browser or app may not be secure. Learn more";
  expect(verificationSignInBlocked("https://accounts.google.com", rejection)).toBe(true);
  expect(verificationSignInBlocked("https://www.youtube.com", rejection)).toBe(false);
  expect(verificationSignInBlocked("https://accounts.google.com.evil.test", rejection)).toBe(false);
  for (const prompt of [
    "Enter your password",
    "Wrong password. Try again",
    "Verify it’s you",
    "Connecting to your device",
    "Sign in to confirm you’re not a bot",
  ])
    expect(verificationSignInBlocked("https://accounts.google.com", prompt)).toBe(false);
});
it("matches source IDs and exact normalized titles, never unrelated names or array order", () => {
  const rows = [item("g0zlErdfXlg", "Daily wisdom"), item("ABCDEFGHIJK", "Be kind")];
  expect(
    matchOriginalRecordings(["Recording [ABCDEFGHIJK].mp4", "Daily wisdom.mp4", "clip.mp4"], rows),
  ).toEqual(["ABCDEFGHIJK", "g0zlErdfXlg", ""]);
});
it("requires a choice for ambiguous titles, repeated sources, and completed masters", () => {
  expect(
    matchOriginalRecordings(
      ["Daily wisdom.mp4"],
      [item("a", "Daily wisdom"), item("b", "Daily wisdom")],
    ),
  ).toEqual([""]);
  expect(
    matchOriginalRecordings(["g0zlErdfXlg.mp4", "New [g0zlErdfXlg].mp4"], [item("g0zlErdfXlg")]),
  ).toEqual(["", ""]);
  expect(
    matchOriginalRecordings(["g0zlErdfXlg.mp4"], [item("g0zlErdfXlg", null, "complete")]),
  ).toEqual([""]);
});
it("recognizes Hub original filenames without confusing hyphens inside source IDs", () => {
  const rows = [item("N2Ni4WMEQJE"), item("a_b-cDEFGHI")];
  expect(
    matchOriginalRecordings(
      ["youtube-N2Ni4WMEQJE-master.mp4", "youtube-a_b-cDEFGHI-master.mp4"],
      rows,
    ),
  ).toEqual(["N2Ni4WMEQJE", "a_b-cDEFGHI"]);
  expect(matchOriginalRecordings(["unrelated-N2Ni4WMEQJE-master.mp4"], rows)).toEqual([""]);
});
