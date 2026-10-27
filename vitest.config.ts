import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/e2e belongs to Playwright (pnpm test:e2e) — vitest must not
    // collect it: both frameworks claim *.spec.ts
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-*/**",
      // CDK copies a Lambda's whole directory into `cdk.out/asset.<hash>/` when
      // it bundles it, test file and all. Collected from there, the same test
      // runs twice and its second name is a hash nobody can place — so the
      // count moves for no reason anybody can explain (measured: 2,346 to
      // 2,352 after one `cdk synth`). Generated output is not source.
      "**/cdk.out/**",
      "migration/**",
      // Presentation and staging bundles under outputs/ are gitignored copies of
      // the source tree; collected from there, their tests fail on unresolved
      // workspace packages and double-count everything else.
      "outputs/**",
      "tests/e2e/**",
      "tests/review-e2e/**",
    ],
    passWithNoTests: true,
  },
});
