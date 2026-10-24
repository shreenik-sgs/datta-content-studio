import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("allows Chromium's namespace chroot while retaining a default-deny container profile", async () => {
  const profile = JSON.parse(
    await readFile(new URL("../import-verification-seccomp.json", import.meta.url), "utf8"),
  );
  expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  for (const syscall of ["clone", "setns", "unshare", "chroot"]) {
    expect(
      profile.syscalls.some(
        (rule: { names: string[]; action: string; includes?: object }) =>
          rule.names.includes(syscall) &&
          rule.action === "SCMP_ACT_ALLOW" &&
          Object.keys(rule.includes ?? {}).length === 0,
      ),
    ).toBe(true);
  }
});

it("tests the real sandbox without network or credentials before replacing the service", async () => {
  const script = await readFile(new URL("./start-services.sh", import.meta.url), "utf8");
  expect(script).toContain("--network none --cap-drop ALL --security-opt no-new-privileges");
  expect(script).toContain("chromiumSandbox:true");
  expect(script).not.toContain("--no-sandbox");
  expect(script.indexOf("Sandboxed verification browser passed startup check.")).toBeLessThan(
    script.indexOf("docker rm -f dcs-staging-worker"),
  );
});
