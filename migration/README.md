# Migration reference only

These files preserve the original integration and infrastructure for review.
They are not part of Content Studio's build, test suite or deployment pipeline.
In particular, **do not execute the legacy AWS scripts**: they target existing
SGS Datta Sannidhi staging/production resources. New infrastructure must use a
separate origin, database access, secrets, buckets and services.

`source.json` records the source commit. `dependency-patch-review.json` records
which patches became unused after removing the Sannidhi/mobile dependencies.
The patch files themselves are retained. Historical end-to-end fixtures target
the old shared identity service and are preserved only as migration references.
