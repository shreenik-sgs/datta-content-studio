import { defineConfig, devices } from "@playwright/test";

/** Explicitly started local services only. Never inherit the general suite's
 * database warmup, fixture sweep or webServer startup. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: [
    "distribution-content.spec.ts",
    "distribution-roles.spec.ts",
    "distribution-guidance.spec.ts",
    "distribution-analytics.spec.ts",
    "distribution-nurturing.spec.ts",
    "distribution-native.spec.ts",
    "distribution-auth.spec.ts",
    "distribution-editorial.spec.ts",
    "distribution-render.spec.ts",
    "distribution-outreach.spec.ts",
    "distribution-social.spec.ts",
    "distribution-studio.spec.ts",
    "distribution-workspace.spec.ts",
  ],
  outputDir: "../test-results/distribution",
  timeout: 120000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020",
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
