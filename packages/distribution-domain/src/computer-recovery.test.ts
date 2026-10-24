import { expect, it } from "vitest";
import {
  COMPUTER_RECOVERY_ORIGIN,
  computerRecoveryBundle,
  computerRecoveryEnabled,
} from "./computer-recovery";
const id = "2eb8dfae-1493-4900-ab9c-a6e6d8813696";
it("accepts only a named GBADPT staging playlist, never a supplied download host", () => {
  expect(
    computerRecoveryBundle(`${COMPUTER_RECOVERY_ORIGIN}/distribution?view=studio&bundle=${id}`),
  ).toBe(id);
  for (const value of [
    `https://evil.test/distribution?bundle=${id}`,
    `https://gbadpt.sgsdattasannidhi.org.evil.test/distribution?bundle=${id}`,
    `${COMPUTER_RECOVERY_ORIGIN}/distribution?bundle=${id}&bundle=${id}`,
    `${COMPUTER_RECOVERY_ORIGIN}/other?bundle=${id}`,
    `https://user@gbadpt.sgsdattasannidhi.org/distribution?bundle=${id}`,
    `http://localhost:3070/distribution?bundle=${id}`,
  ])
    expect(computerRecoveryBundle(value)).toBeNull();
});
it("enables execution only on the explicitly configured local GBADPT TEST instance", () => {
  const env = {
    STUDIO_IDENTITY: "gbadpt",
    DISTRIBUTION_HUB_STAGE: "TEST",
    DISTRIBUTION_HUB_ENABLED: "true",
    STUDIO_COMPUTER_RECOVERY_ENABLED: "true",
    DISTRIBUTION_APP_ORIGIN: "http://localhost:3070",
  };
  expect(computerRecoveryEnabled(env)).toBe(true);
  for (const change of [
    { STUDIO_IDENTITY: "dp" },
    { DISTRIBUTION_HUB_STAGE: "ON" },
    { STUDIO_COMPUTER_RECOVERY_ENABLED: "false" },
    { DISTRIBUTION_APP_ORIGIN: COMPUTER_RECOVERY_ORIGIN },
    { DISTRIBUTION_APP_ORIGIN: "http://localhost:3020" },
  ])
    expect(computerRecoveryEnabled({ ...env, ...change })).toBe(false);
});
