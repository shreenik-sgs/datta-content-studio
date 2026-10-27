# Datta Content Studio

Owner deployment scope, 20 October 2026: run Content Studio independently on
localhost (port 3070) and its own staging origin. Production is reserved for
SGS Datta Sannidhi; do not deploy Content Studio to production. Keep Sannidhi's
local preview on port 3020 available alongside Studio.

This is an independent curation application. Never read Sannidhi account tables,
reuse its session cookie, or deploy into its ECS services. Use only the configured
DISTRIBUTION_DATABASE_URL and this app's operator accounts. Stored content, consent,
source evidence and approval history must survive changes. Keep TEST and LIVE rows
separate, keep approved outputs immutable, and recheck current operator roles for
worker actions. Business rules stay in packages/distribution-domain with zero I/O.
Run pnpm check before committing; never bypass a failing hook. Migration references
under migration/ are historical source, not executable deployments or active tests.
