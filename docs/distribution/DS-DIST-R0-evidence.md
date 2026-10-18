# DS-DIST-R0 evidence — architecture and isolation

Date: 29 September 2026. Scope: local review branch only. No commit, push or deployment.

## Dependency map

`distribution-web` depends only on versioned Distribution contracts and pure
Distribution domain rules. `distribution-worker` depends only on the pure
Distribution domain. `distribution-db` owns the additive `distribution` schema.
Existing web, mobile, fanout, worker and core packages have no import edge to
any Distribution package; `ops/distribution-isolation.test.ts` enforces it.

## Failure and rollback evidence

- Missing/invalid stage and disabled feature switch refuse all non-health work.
- Worker OFF creates no queue or provider plan and exits successfully.
- Production cannot use the local TEST operator shortcut.
- A temporary Hub on :3070 returned 200 in TEST; after it stopped, core :3020
  still returned `{"ok":true}`. In production-default configuration, Hub root
  returned 404, health returned 200 with stage OFF, and core remained 200.
- Rollback is disabling the two gates and stopping the two independent services.
  The generated schema is additive and is retained unless empty and separately
  approved for removal.

## Persistence boundary

Drizzle generated `packages/distribution-db/drizzle/0000_grey_wendell_rand.sql`.
Its journal is `distribution_migrations.__distribution_migrations`, separate from core.
`ops/test-distribution-db-boundary.sh` created a disposable local database and
proved the runtime role could insert/read `distribution.module_state` while a
read of an existing public-schema probe was denied. The script removed the
database and role on exit.

## NFR baseline

- Core health before/during/after Hub verification: HTTP 200.
- Hub liveness is dependency-free and explicitly reports OFF as healthy-disabled.
- Queue and storage keys are allow-listed and traversal/control characters fail.
- Docker targets for Distribution web and worker build successfully and default
  both gates to OFF.
- Provider calls, paid work, public publishing and analytics are absent in R0,
  so observed provider cost is $0.

## Gates run

- `pnpm distribution:check`: 11 Distribution assertions plus all five builds.
- `pnpm exec vitest run ops/distribution-isolation.test.ts`: pass.
- `bash ops/test-distribution-db-boundary.sh`: pass and cleanup verified.
- `docker build --target distribution-worker .`: pass.
- `docker build --target distribution-web .`: pass.
- `pnpm check`: 296 files passed, 42 skipped; 2,608 tests passed, 297 skipped.
- `pnpm docs:check`: 53 document sets current; three interactive editions current.

## Deliberate boundary

R0 has no production operator path. Real session-to-capability authorization,
canonical content, private asset access, operator audit and localized workflow
begin in R1. LIMITED and ON therefore remain inaccessible rather than relying
on an environment identity shortcut.
